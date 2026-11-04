import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { AppError, USERS, taskService } from './data.mjs';
import { createTaskRead } from './task-read.mjs';
import { createLifecycle } from './extension-lifecycle.mjs';
import { loadHost } from './extension-catalog.mjs';
import { createAuthoringService, AUTHORING_CODES } from './authoring-service.mjs';
import { authoringChoices } from './authoring-config.mjs';
import { assertAuthoringSettingsLocation, createAuthoringSettings } from './authoring-settings.mjs';
import { authoringExample } from './authoring-example.mjs';

const nonce = () => randomBytes(32).toString('hex');
const COOKIE = 'keir_demo_session';
// Encoded URL aliases must share the matched route's security and privacy checks.
const routePath = request => request.routeOptions.url ?? request.url.split('?')[0];

export async function createApp({ db, origin, staticRoot = resolve('dist'), compiler, authoring = {}, authoringSettingsFile }) {
  assertAuthoringSettingsLocation(authoringSettingsFile, staticRoot);
  const url = new URL(origin);
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024, requestTimeout: 10_000, connectionTimeout: 10_000, ajv: { customOptions: { removeAdditional: false } } });
  const sessions = new Map();
  const anonymousContext = nonce();
  const service = taskService(db);
  if (compiler === undefined) {
    try { const { createCompiler } = await import('./compiler.mjs'); compiler = createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: process.env.KEIR_JAVA_BIN }); }
    catch { /* Missing compiler assets never prevent native or stored advice startup. */ }
  }
  const lifecycle = createLifecycle(db, { compiler });
  const settings = createAuthoringSettings({ file: authoringSettingsFile, config: authoring.config });
  const ai = createAuthoringService({ db, lifecycle, ...authoring, config: settings.config });
  app.addHook('onClose', () => ai.close());
  const taskAdvice = createTaskRead({ getTask: service.getTask, lifecycle });
  await app.register(cookie);
  app.decorateRequest('scope', null);
  function current(request) { return sessions.get(request.cookies[COOKIE]); }
  function authorize(request) {
    const session = current(request);
    if (!session || session !== request.scope || request.headers['x-session-context'] !== session.contextToken) throw new AppError(401, 'Your demo session changed. Sign in again.');
    return session;
  }
  function authContext(request) {
    const session = current(request);
    if (request.scope !== (session ?? null) || request.headers['x-session-context'] !== (session?.contextToken ?? anonymousContext)) throw new AppError(401, 'Your demo session changed. Sign in again.');
    return session;
  }
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== url.host) return done(new AppError(403, 'Unexpected request host.'));
    request.scope = current(request) ?? null;
    if (routePath(request).startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.headers.origin !== origin) return done(new AppError(403, 'Use the same local app origin.'));
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return done(new AppError(415, 'Send application/json.'));
      }
    }
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.status : error.statusCode ?? 500;
    if (routePath(request) === '/api/authoring/setup') {
      const message = error instanceof AppError ? error.message : ({ 400: 'Send valid JSON settings using the supported fields.',
        413: 'Settings exceed the request size limit.', 415: 'Send application/json.' }[status] ?? 'Settings could not be processed safely.');
      return reply.code(status).send({ message, ...(AUTHORING_CODES.includes(error.code) ? { code: error.code } : {}) });
    }
    const diagnostics = error instanceof AppError && Array.isArray(error.diagnostics)
      && Buffer.byteLength(JSON.stringify(error.diagnostics)) <= 16384 ? error.diagnostics : undefined;
    reply.code(status).send({ message: status >= 500 && !(error instanceof AppError) ? 'Something could not be saved. Please try again.' : error.message,
      ...(diagnostics ? { diagnostics } : {}), ...(AUTHORING_CODES.includes(error.code) ? { code: error.code } : {}) });
  });
  app.get('/api/session', request => {
    const session = current(request);
    return { user: session ? USERS.find(user => user.id === session.userId) && { id: session.userId, name: USERS.find(user => user.id === session.userId).name } : null,
      contextToken: session?.contextToken ?? anonymousContext,
      users: USERS.map(({ id, name, description }) => ({ id, name, description })) };
  });
  app.post('/api/session', (request, reply) => {
    const prior = authContext(request);
    if (!request.body || Object.keys(request.body).length !== 1 || !USERS.some(user => user.id === request.body.userId)) throw new AppError(400, 'Choose one of the three demo people.');
    const id = nonce(), userId = request.body.userId, contextToken = nonce();
    if (prior) { sessions.delete(request.cookies[COOKIE]); ai.invalidateSession(prior.authoringEpoch); }
    sessions.set(id, { userId, contextToken, authoringEpoch: nonce() });
    reply.setCookie(COOKIE, id, { path: '/', httpOnly: true, sameSite: 'strict' });
    return { user: { id: userId, name: USERS.find(user => user.id === userId).name }, contextToken };
  });
  app.delete('/api/session', (request, reply) => {
    authContext(request);
    const prior = current(request);
    sessions.delete(request.cookies[COOKIE]);
    if (prior) ai.invalidateSession(prior.authoringEpoch);
    reply.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' });
    return { user: null, contextToken: anonymousContext };
  });
  app.get('/api/projects', request => service.listProjects(authorize(request).userId));
  const lifecycleResponse = value => {
    if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new AppError(413, 'Advice response exceeds the host limit.');
    return value;
  };
  const noQuery = request => { if (Object.keys(request.query).length) throw new AppError(400, 'This advice request takes no query fields.'); };
  function authoringLease(request) {
    const session = authorize(request);
    return { sessionId: session.authoringEpoch, current: () => { try { return authorize(request) === session; } catch { return false; } } };
  }
  const setupResponse = () => ({ configuration: settings.publicConfiguration(), choices: authoringChoices, availability: ai.availability() });
  function setupAuthority(request) {
    authorize(request); noQuery(request);
    if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new AppError(403, 'Use the same local app origin.');
  }
  app.get('/api/authoring/setup', request => { setupAuthority(request); return setupResponse(); });
  app.post('/api/authoring/setup', { bodyLimit: 8192 }, request => {
    setupAuthority(request);
    const next = settings.prepare(request.body);
    ai.configure(next.config, next.persist);
    return setupResponse();
  });
  app.get('/api/authoring', request => {
    if (Object.keys(request.query).some(key => key !== 'extensionId') || request.query.extensionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(request.query.extensionId)) throw new AppError(400, 'Use an exact extension identity.');
    return lifecycleResponse(ai.list(authorize(request).userId, request.query.extensionId));
  });
  app.get('/api/authoring/example', request => { authorize(request); noQuery(request); return lifecycleResponse(authoringExample()); });
  app.get('/api/authoring/conversations/:id', request => { noQuery(request); return lifecycleResponse(ai.read(authorize(request).userId, request.params.id)); });
  app.post('/api/authoring/turn', { bodyLimit: 65536 }, async (request, reply) => {
    noQuery(request); const session = authorize(request), lease = authoringLease(request);
    const result = await ai.turn(session.userId, request.body, lease); authorize(request);
    reply.code(202); return lifecycleResponse(result);
  });
  app.post('/api/authoring/conversations/:id/cancel', (request, reply) => {
    noQuery(request); const session = authorize(request);
    return lifecycleResponse(ai.cancel(session.userId, request.params.id, request.body, authoringLease(request)));
  });
  app.get('/api/extensions', request => { noQuery(request); return lifecycleResponse(lifecycle.collection(authorize(request).userId)); });
  app.get('/api/extensions/catalog', request => { authorize(request); noQuery(request); return lifecycleResponse(lifecycle.hostCatalog()); });
  app.get('/api/extensions/:extensionId', request => { noQuery(request); return lifecycleResponse(lifecycle.state(authorize(request).userId, request.params.extensionId)); });
  app.post('/api/extensions', { bodyLimit: 1048576 }, async (request, reply) => {
    noQuery(request); const session = authorize(request), input = request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operationId', 'source', 'label'].includes(key))
        || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId) || typeof input.source !== 'string') throw new AppError(400, 'Use a source and creation operation identity.');
    const result = await withSignal(request, reply, signal => lifecycle.createFromSource(session.userId, input, () => authorize(request), { signal }));
    authorize(request); return lifecycleResponse(result);
  });
  app.post('/api/extensions/:extensionId/rename', request => {
    noQuery(request); const session = authorize(request), input = request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
        || !['name', 'expectedName'].every(field => Object.hasOwn(input, field))) throw new AppError(400, 'Use only the name and expected name.');
    return lifecycleResponse(lifecycle.rename(session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request)));
  });
  app.get('/api/extensions/:extensionId/evidence/:id', request => { noQuery(request); return lifecycleResponse(lifecycle.evidence(authorize(request).userId, request.params.id, request.params.extensionId)); });
  app.get('/api/extensions/:extensionId/revisions/:id', request => {
    noQuery(request); const value = lifecycle.source(authorize(request).userId, request.params.id, request.params.extensionId);
    if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new AppError(413, 'Source response exceeds the host limit.');
    return value;
  });
  app.get('/api/extensions/:extensionId/history', request => {
    if (Object.keys(request.query).some(key => key !== 'before') || request.query.before !== undefined && !/^[1-9][0-9]{0,15}$/.test(request.query.before)) throw new AppError(400, 'Use a valid history cursor.');
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (before !== undefined && !Number.isSafeInteger(before)) throw new AppError(400, 'Use a valid history cursor.');
    return lifecycleResponse(lifecycle.history(authorize(request).userId, before, request.params.extensionId));
  });
  const operations = { draft: ['templateId', 'draftVersion'], simulate: ['revisionId', 'draftVersion'], approve: ['revisionId', 'draftVersion', 'evidenceId'],
    activate: ['revisionId', 'draftVersion', 'generation'], disable: ['generation'], rollback: ['revisionId', 'generation'], restart: ['revisionId', 'draftVersion', 'generation'] };
  async function withSignal(request, reply, action) {
    const abort = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) abort.abort(); };
    request.raw.once('aborted', disconnected); reply.raw.once('close', disconnected);
    if (request.raw.aborted || reply.raw.destroyed) abort.abort();
    try { return await action(abort.signal); }
    finally { request.raw.removeListener('aborted', disconnected); reply.raw.removeListener('close', disconnected); }
  }
  for (const [operation, fields] of Object.entries(operations)) app.post(`/api/extensions/:extensionId/${operation}`, async (request, reply) => {
    const session = authorize(request), input = request.body;
    noQuery(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
        || !fields.every(field => Object.hasOwn(input, field) && (['draftVersion', 'generation'].includes(field)
          ? Number.isSafeInteger(input[field]) && input[field] >= 0 : typeof input[field] === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(input[field]))))
      throw new AppError(400, 'Use only the supported advice fields.');
    const result = await withSignal(request, reply, signal => lifecycle[operation === 'draft' ? 'load' : operation](session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request), { signal }));
    authorize(request);
    return lifecycleResponse(result);
  });
  for (const operation of ['compile', 'scenarios']) app.post(`/api/extensions/:extensionId/${operation}`, { bodyLimit: 1048576 }, async (request, reply) => {
    const session = authorize(request), input = request.body;
    noQuery(request);
    const fields = operation === 'compile' ? ['source', 'draftVersion'] : ['revisionId', 'cases', 'draftVersion'];
    const allowed = operation === 'compile' ? [...fields, 'label'] : fields;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))
        || fields.some(field => !Object.hasOwn(input, field)) || !Number.isSafeInteger(input.draftVersion) || input.draftVersion < 0
        || operation === 'scenarios' && (typeof input.revisionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(input.revisionId)))
      throw new AppError(400, 'Use only the supported preparation fields.');
    const result = await withSignal(request, reply, signal => lifecycle[operation === 'compile' ? 'compile' : 'proposeScenarios'](
      session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request), { signal }));
    authorize(request); return lifecycleResponse(result);
  });
  app.post('/api/projects', (request, reply) => { const result = service.createProject(authorize(request).userId, request.body); reply.code(201); return result; });
  app.patch('/api/projects/:id', request => service.renameProject(authorize(request).userId, request.params.id, request.body));
  app.get('/api/projects/:id/tasks', request => service.listTasks(authorize(request).userId, request.params.id));
  app.get('/api/tasks/:id', request => service.getTask(authorize(request).userId, request.params.id));
  app.post('/api/tasks/:id/advice', async request => {
    const session = authorize(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length) throw new AppError(400, 'Task advice takes no fields.');
    const result = await taskAdvice({ userId: session.userId, taskId: request.params.id,
      authorize: () => { try { return authorize(request) === session; } catch { return false; } } });
    authorize(request);
    return result;
  });
  app.post('/api/tasks', (request, reply) => { const result = service.createTask(authorize(request).userId, request.body); reply.code(201); return result; });
  app.patch('/api/tasks/:id', request => service.editTask(authorize(request).userId, request.params.id, request.body));
  app.post('/api/tasks/:id/complete', request => {
    const session = authorize(request);
    if (!request.body || Object.keys(request.body).length) throw new AppError(400, 'Completion takes no fields.');
    return service.completeTask(session.userId, request.params.id);
  });
  await app.register(staticFiles, { root: staticRoot, index: ['index.html'], dotfiles: 'deny',
    allowedPath(path, root) {
      try {
        const location = relative(realpathSync(root), realpathSync(join(root, path)));
        return location === '' || !isAbsolute(location) && location !== '..' && !location.startsWith('..' + sep);
      } catch { return false; }
    },
  });
  return app;
}
