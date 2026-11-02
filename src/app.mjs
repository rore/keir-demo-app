import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError, USERS, taskService } from './data.mjs';
import { createTaskRead } from './task-read.mjs';
import { createLifecycle } from './extension-lifecycle.mjs';
import { loadHost } from './extension-catalog.mjs';

const nonce = () => randomBytes(32).toString('hex');
const COOKIE = 'keir_demo_session';

export async function createApp({ db, origin, staticRoot = resolve('dist'), compiler }) {
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
    if (request.url.startsWith('/api/')) {
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
    const diagnostics = error instanceof AppError && Array.isArray(error.diagnostics)
      && Buffer.byteLength(JSON.stringify(error.diagnostics)) <= 16384 ? error.diagnostics : undefined;
    reply.code(status).send({ message: status >= 500 && !(error instanceof AppError) ? 'Something could not be saved. Please try again.' : error.message,
      ...(diagnostics ? { diagnostics } : {}) });
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
    if (prior) sessions.delete(request.cookies[COOKIE]);
    sessions.set(id, { userId, contextToken });
    reply.setCookie(COOKIE, id, { path: '/', httpOnly: true, sameSite: 'strict' });
    return { user: { id: userId, name: USERS.find(user => user.id === userId).name }, contextToken };
  });
  app.delete('/api/session', (request, reply) => {
    authContext(request);
    sessions.delete(request.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' });
    return { user: null, contextToken: anonymousContext };
  });
  app.get('/api/projects', request => service.listProjects(authorize(request).userId));
  const lifecycleResponse = value => {
    if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new AppError(413, 'Advice response exceeds the host limit.');
    return value;
  };
  const noQuery = request => { if (Object.keys(request.query).length) throw new AppError(400, 'This advice request takes no query fields.'); };
  app.get('/api/extensions', request => { noQuery(request); return lifecycleResponse(lifecycle.state(authorize(request).userId)); });
  app.get('/api/extensions/evidence/:id', request => { noQuery(request); return lifecycleResponse(lifecycle.evidence(authorize(request).userId, request.params.id)); });
  app.get('/api/extensions/revisions/:id', request => {
    noQuery(request); const value = lifecycle.source(authorize(request).userId, request.params.id);
    if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new AppError(413, 'Source response exceeds the host limit.');
    return value;
  });
  app.get('/api/extensions/history', request => {
    if (Object.keys(request.query).some(key => key !== 'before') || request.query.before !== undefined && !/^[1-9][0-9]{0,15}$/.test(request.query.before)) throw new AppError(400, 'Use a valid history cursor.');
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (before !== undefined && !Number.isSafeInteger(before)) throw new AppError(400, 'Use a valid history cursor.');
    return lifecycleResponse(lifecycle.history(authorize(request).userId, before));
  });
  const operations = { draft: ['templateId', 'draftVersion'], simulate: ['revisionId', 'draftVersion'], approve: ['revisionId', 'draftVersion', 'evidenceId'],
    activate: ['revisionId', 'draftVersion', 'generation'], disable: ['generation'], rollback: ['revisionId', 'generation'] };
  async function withSignal(request, reply, action) {
    const abort = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) abort.abort(); };
    request.raw.once('aborted', disconnected); reply.raw.once('close', disconnected);
    if (request.raw.aborted || reply.raw.destroyed) abort.abort();
    try { return await action(abort.signal); }
    finally { request.raw.removeListener('aborted', disconnected); reply.raw.removeListener('close', disconnected); }
  }
  for (const [operation, fields] of Object.entries(operations)) app.post(`/api/extensions/${operation}`, async (request, reply) => {
    const session = authorize(request), input = request.body;
    noQuery(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
        || !fields.every(field => Object.hasOwn(input, field) && (['draftVersion', 'generation'].includes(field)
          ? Number.isSafeInteger(input[field]) && input[field] >= 0 : typeof input[field] === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(input[field]))))
      throw new AppError(400, 'Use only the supported advice fields.');
    const result = await withSignal(request, reply, signal => lifecycle[operation === 'draft' ? 'load' : operation](session.userId, input, () => authorize(request), { signal }));
    authorize(request);
    return lifecycleResponse(result);
  });
  for (const operation of ['compile', 'scenarios']) app.post(`/api/extensions/${operation}`, { bodyLimit: 1048576 }, async (request, reply) => {
    const session = authorize(request), input = request.body;
    noQuery(request);
    const fields = operation === 'compile' ? ['source', 'draftVersion'] : ['revisionId', 'cases', 'draftVersion'];
    const allowed = operation === 'compile' ? [...fields, 'label'] : fields;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))
        || fields.some(field => !Object.hasOwn(input, field)) || !Number.isSafeInteger(input.draftVersion) || input.draftVersion < 0
        || operation === 'scenarios' && (typeof input.revisionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(input.revisionId)))
      throw new AppError(400, 'Use only the supported preparation fields.');
    const result = await withSignal(request, reply, signal => lifecycle[operation === 'compile' ? 'compile' : 'proposeScenarios'](
      session.userId, input, () => authorize(request), { signal }));
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
  await app.register(staticFiles, { root: staticRoot, index: ['index.html'], dotfiles: 'deny' });
  return app;
}
