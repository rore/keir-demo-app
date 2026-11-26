import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { AppError, USERS, taskService, transaction } from './data.mjs';
import { createTaskDispatcher } from './task-effects.mjs';
import { createTaskCreateGuard } from './task-create-guard.mjs';
import { createTeamRuntime } from './team-runtime.mjs';
import { taskAccess, teamProjectService } from './team-native.mjs';
import { createTeamCapability } from './team-capability.mjs';
import { TASK_HOOK, TASK_EVENT_HOOKS } from './extension-catalog.mjs';
import { createLifecycle, sharedStudioCreationHash } from './extension-lifecycle.mjs';
import { createAuthoringService, AUTHORING_CODES } from './authoring-service.mjs';
import { authoringChoices } from './authoring-config.mjs';
import { assertAuthoringSettingsLocation, createAuthoringSettings } from './authoring-settings.mjs';
import { createSharedCompletion } from './shared-completion.mjs';
import { BUNDLE_MANIFEST, COMPOSED_MANIFEST } from './shared-task-bundle.mjs';

const nonce = () => randomBytes(32).toString('hex');
const COOKIE = 'keir_demo_session';
// Encoded URL aliases must share the matched route's security and privacy checks.
const routePath = request => request.routeOptions.url ?? request.url.split('?')[0];

export async function createApp({ db, origin, staticRoot = resolve('dist'), compiler, guard, authoring = {}, authoringSettingsFile,
  sharedCompletionWriteReply }) {
  assertAuthoringSettingsLocation(authoringSettingsFile, staticRoot);
  const url = new URL(origin);
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024, requestTimeout: 10_000, connectionTimeout: 10_000, ajv: { customOptions: { removeAdditional: false } } });
  const sessions = new Map();
  const anonymousContext = nonce();
  if (compiler === undefined) {
    try { const { createCompiler } = await import('./compiler.mjs'); compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }); }
    catch { /* Missing compiler assets never prevent native or stored advice startup. */ }
  }
  const lifecycle = createLifecycle(db, { compiler });
  const capability = createTeamCapability(db, { sharedCompiler: compiler });
  guard ??= createTaskCreateGuard({ db, lifecycle, commitReserveMs: 100,
    teamCapability: capability, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding });
  const shared = createSharedCompletion({ db, lifecycle, teamCapability: capability, guard, writeReply: sharedCompletionWriteReply });
  const team = createTeamRuntime({ db, sharedCompletion: shared });
  const service = taskService(db, { guard, team, sharedCompletion: shared });
  const teamProjects = teamProjectService(db);
  const effects = createTaskDispatcher({ db, lifecycle, guard });
  const settings = createAuthoringSettings({ file: authoringSettingsFile, config: authoring.config });
  const ai = createAuthoringService({ db, lifecycle, ...authoring, config: settings.config, teamCapability: capability, teamProjects,
    sharedCompletionCompiler: compiler ?? null });
  let sharedDrain, sharedAfter = 0, createdAfter = 0, sharedRequested = false, closing = false;
  function wakeShared() {
    if (closing) return;
    sharedRequested = true;
    if (sharedDrain) return;
    sharedDrain = (async () => {
      sharedRequested = false;
      while (!closing) {
        const created = db.prepare(`SELECT rowid AS sequence,event_id FROM task_events WHERE hook_id='TaskCreated'
          AND state='PENDING' AND json_extract(pins,'$.format') IN (?,?) AND rowid>? ORDER BY rowid LIMIT 1`)
          .get(BUNDLE_MANIFEST, COMPOSED_MANIFEST, createdAfter);
        if (created) {
          createdAfter = created.sequence;
          try { await shared.run(created.event_id); } catch { /* Unavailable exact attempts never fall back. */ }
          continue;
        }
        const row = db.prepare("SELECT rowid AS sequence,id FROM shared_completion_events WHERE state='PENDING' AND rowid>? ORDER BY rowid LIMIT 1").get(sharedAfter);
        if (!row) break;
        sharedAfter = row.sequence;
        try { await shared.run(row.id); } catch { /* Exact unavailable/revoked attempts are not replayed. */ }
      }
    })().catch(() => { /* The saved attempt remains authoritative. */ }).finally(() => {
      sharedDrain = undefined;
      if (sharedRequested) wakeShared();
    });
  }
  app.addHook('preClose', async () => { await capability.close(); });
  app.addHook('onClose', async () => { closing = true; await Promise.all([ai.close(), effects.close(), team.close(), guard.close?.(), sharedDrain]); });
  const wakeEffects = () => setImmediate(() => { void effects.wake().catch(() => {}); void team.wake().catch(() => {}); wakeShared(); });
  app.addHook('onReady', async () => { wakeEffects(); });
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
    if (routePath(request) === '/api/tasks' && error instanceof AppError && error.state === 'NOT_CREATED'
        && ['RULE_DENIED', 'CHECK_UNAVAILABLE', 'STALE_ATTEMPT', 'NATIVE_REJECTED'].includes(error.code))
      return reply.code(status).send({ operationId: error.operationId, state: error.state, code: error.code, message: error.message });
    reply.code(status).send({ message: status >= 500 && !(error instanceof AppError) ? 'Something could not be saved. Please try again.' : error.message,
      ...(diagnostics ? { diagnostics } : {}), ...([...AUTHORING_CODES, 'CUSTOMIZATION_DELETED', 'CUSTOMIZATION_BUSY', 'CREATE_PAYLOAD_MISMATCH'].includes(error.code) ? { code: error.code } : {}) });
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
    const execution = effects.availability();
    if (value?.executionAvailability && execution.available === false) {
      value.executionAvailability = execution;
      if (value.selection) value.selection.eligible = false;
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new AppError(413, 'Customization response exceeds the host limit.');
    return value;
  };
  const noQuery = request => { if (Object.keys(request.query).length) throw new AppError(400, 'This customization request takes no query fields.'); };
  const pageQuery = request => {
    if (Object.keys(request.query).some(key => key !== 'before') || request.query.before !== undefined
        && (typeof request.query.before !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(request.query.before))) throw new AppError(400, 'Use a valid page cursor.');
    return request.query.before;
  };
  function authoringLease(request) {
    const session = authorize(request);
    return { sessionId: session.authoringEpoch, current: () => { try { return authorize(request) === session; } catch { return false; } } };
  }
  const setupResponse = () => ({ configuration: settings.publicConfiguration(), choices: authoringChoices, availability: ai.availability(),
    allowance: ai.allowance() });
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
  const authoringQuery = (request, requireItem = false) => {
    if (Object.keys(request.query).some(key => !['extensionId', 'before'].includes(key))
        || requireItem && request.query.extensionId === undefined
        || request.query.extensionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(request.query.extensionId)
        || request.query.before !== undefined && !/^[A-Za-z0-9_-]{1,2048}$/.test(request.query.before)) throw new AppError(400, 'Use an exact extension identity and valid page cursor.');
    return [authorize(request).userId, request.query.extensionId, request.query.before];
  };
  app.get('/api/authoring', request => lifecycleResponse(ai.list(...authoringQuery(request))));
  app.get('/api/authoring/transcript', request => lifecycleResponse(ai.transcript(...authoringQuery(request, true))));
  app.get('/api/authoring/conversations/:id', request => { noQuery(request); return lifecycleResponse(ai.read(authorize(request).userId, request.params.id)); });
  app.get('/api/authoring/conversations/:id/messages', request => lifecycleResponse(ai.messages(authorize(request).userId, request.params.id, pageQuery(request))));
  app.post('/api/authoring/recover', { bodyLimit: 65536 }, request => {
    noQuery(request); return lifecycleResponse(ai.recover(authorize(request).userId, request.body));
  });
  app.post('/api/authoring/turn', { bodyLimit: 65536 }, async (request, reply) => {
    noQuery(request); const session = authorize(request), lease = authoringLease(request);
    const result = await ai.turn(session.userId, request.body, lease, { continueOnly: true }); authorize(request);
    reply.code(202); return lifecycleResponse(result);
  });
  app.post('/api/authoring/conversations/:id/cancel', (request, reply) => {
    noQuery(request); const session = authorize(request);
    return lifecycleResponse(ai.cancel(session.userId, request.params.id, request.body, authoringLease(request)));
  });
  app.get('/api/extensions', request => lifecycleResponse(lifecycle.collection(authorize(request).userId, { before: pageQuery(request) })));
  app.get('/api/extensions/creation/:operationId', request => { noQuery(request); return lifecycleResponse(lifecycle.findCreation(authorize(request).userId, request.params.operationId)); });
  app.get('/api/extensions/catalog', request => { authorize(request); noQuery(request); return lifecycleResponse(lifecycle.hostCatalog()); });
  app.get('/api/extensions/:extensionId', request => { noQuery(request); return lifecycleResponse(lifecycle.state(authorize(request).userId, request.params.extensionId)); });
  app.post('/api/extensions/:extensionId/rename', request => {
    noQuery(request); const session = authorize(request), input = request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
        || !['name', 'expectedName'].every(field => Object.hasOwn(input, field))) throw new AppError(400, 'Use only the name and expected name.');
    return lifecycleResponse(lifecycle.rename(session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request)));
  });
  app.post('/api/extensions/:extensionId/delete', request => {
    noQuery(request); const session = authorize(request), input = request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
        || !['expectedName', 'draftVersion', 'generation'].every(field => Object.hasOwn(input, field))) throw new AppError(400, 'Use only the exact name, draft version and selection generation.');
    return lifecycleResponse(lifecycle.delete(session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request), () => ai.assertItemIdle(session.userId, request.params.extensionId)));
  });
  app.get('/api/extensions/:extensionId/evidence/:id', request => { noQuery(request); return lifecycleResponse(lifecycle.evidence(authorize(request).userId, request.params.id, request.params.extensionId)); });
  for (const [path, method] of [['evidence', 'evidencePage'], ['revisions', 'revisionPage'], ['restore-targets', 'restorePage']]) {
    app.get(`/api/extensions/:extensionId/${path}`, request => lifecycleResponse(lifecycle[method](authorize(request).userId, request.params.extensionId, pageQuery(request))));
  }
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
  const operations = { simulate: ['revisionId', 'draftVersion'], approve: ['revisionId', 'draftVersion', 'evidenceId'],
    activate: ['revisionId', 'draftVersion', 'generation', 'evidenceId'], disable: ['generation'], rollback: ['revisionId', 'generation'], restart: ['revisionId', 'draftVersion', 'generation'] };
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
    if (operation !== 'disable') lifecycle.assertWritable(session.userId, request.params.extensionId);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
        || !fields.every(field => Object.hasOwn(input, field) && (['draftVersion', 'generation'].includes(field)
          ? Number.isSafeInteger(input[field]) && input[field] >= 0
          : (operation === 'activate' && field === 'evidenceId' && input[field] === null)
            || (typeof input[field] === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(input[field])))))
      throw new AppError(400, 'Use only the supported customization fields.');
    if (['activate', 'rollback'].includes(operation) && !effects.availability().available)
      throw new AppError(503, effects.availability().message);
    const result = await withSignal(request, reply, signal => lifecycle[operation](session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request), { signal }));
    authorize(request);
    return lifecycleResponse(result);
  });
  for (const operation of ['compile', 'scenarios']) app.post(`/api/extensions/:extensionId/${operation}`, { bodyLimit: 1048576 }, async (request, reply) => {
    const session = authorize(request), input = request.body;
    noQuery(request);
    lifecycle.assertWritable(session.userId, request.params.extensionId, { earlierOnly: true });
    const fields = operation === 'compile' ? ['hookId', 'source', 'draftVersion'] : ['revisionId', 'cases', 'draftVersion'];
    const allowed = operation === 'compile' ? [...fields, 'label', 'modelDigest'] : fields;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))
        || fields.some(field => !Object.hasOwn(input, field)) || !Number.isSafeInteger(input.draftVersion) || input.draftVersion < 0
        || operation === 'scenarios' && (typeof input.revisionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(input.revisionId)))
      throw new AppError(400, 'Use only the supported preparation fields.');
    const result = await withSignal(request, reply, signal => lifecycle[operation === 'compile' ? 'compile' : 'proposeScenarios'](
      session.userId, { ...input, extensionId: request.params.extensionId }, () => authorize(request), { signal }));
    authorize(request); return lifecycleResponse(result);
  });
  app.post('/api/projects', (request, reply) => {
    const result = service.createProject(authorize(request).userId, request.body, { authorize: () => authorize(request).userId });
    reply.code(201); return result;
  });
  app.post('/api/authoring/conversations/:id/confirm', { bodyLimit: 2048 }, (request, reply) => {
    noQuery(request); const session = authorize(request);
    const result = ai.confirm(session.userId, request.params.id, request.body, authoringLease(request));
    reply.code(202);
    return lifecycleResponse(result);
  });
  app.get('/api/projects/:id/members', request => {
    noQuery(request); return teamProjects.members(authorize(request).userId, request.params.id);
  });
  app.post('/api/projects/:id/members', request => {
    noQuery(request);
    return teamProjects.addMember(authorize(request).userId, request.params.id, request.body, () => authorize(request).userId);
  });
  app.get('/api/projects/:id/capability', request => {
    noQuery(request); const actor = authorize(request).userId;
    return capability.state(actor, request.params.id, () => authorize(request).userId);
  });
  app.get('/api/projects/:id/authoring', request => {
    noQuery(request);
    return lifecycleResponse(ai.team.read(authorize(request).userId, request.params.id, authoringLease(request)));
  });
  app.post('/api/projects/:id/authoring/turn', { bodyLimit: 49152 }, async (request, reply) => {
    noQuery(request);
    const result = await ai.team.turn(authorize(request).userId, request.params.id, request.body, authoringLease(request), { continueOnly: true });
    reply.code(202);
    return lifecycleResponse(result);
  });
  app.post('/api/projects/:id/authoring/cancel', { bodyLimit: 2048 }, request => {
    noQuery(request);
    return lifecycleResponse(ai.team.cancel(authorize(request).userId, request.params.id, request.body, authoringLease(request)));
  });
  app.post('/api/projects/:id/authoring/confirm', { bodyLimit: 2048 }, async (request, reply) => {
    noQuery(request);
    const actor = authorize(request).userId, lease = authoringLease(request);
    const result = await withSignal(request, reply, signal => ai.team.confirm(actor, request.params.id, request.body, lease, signal));
    return lifecycleResponse(result);
  });
  app.get('/api/projects/:id/capability/revisions', request => {
    const actor = authorize(request).userId;
    return capability.revisions(actor, request.params.id, request.query, () => authorize(request).userId);
  });
  for (const [path, method] of [['revisions', 'source'], ['evidence', 'evidence']]) {
    app.get(`/api/projects/:id/capability/${path}/:recordId`, request => {
      noQuery(request); const actor = authorize(request).userId;
      return capability[method](actor, request.params.id, request.params.recordId, () => authorize(request).userId);
    });
  }
  if (ai.sharedCompletion) {
    const studio = ai.sharedCompletion;
    const context = request => [authorize(request).userId, request.params.target, authoringLease(request)];
    const studioResponse = ([actor, key, lease], snapshot) => {
      const result = { ...snapshot, review: studio.review(actor, key, lease) };
      return lifecycleResponse(key.startsWith('TEAM:')
        ? { ...result, ...ai.team.savedWork(actor, key.slice('TEAM:'.length), lease) } : result);
    };
    const readStudio = request => {
      const args = context(request);
      return studioResponse(args, studio.read(...args));
    };
    app.post('/api/shared-studio/new-personal', request => {
      noQuery(request);
      const { operationId } = request.body ?? {};
      if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(operationId) || Object.keys(request.body).length !== 1)
        throw new AppError(400, 'Use an exact creation operation.');
      const actor = authorize(request).userId;
      const state = transaction(db, () => lifecycle.admit(actor, { extensionId: randomUUID(), operationId,
        hash: sharedStudioCreationHash(operationId), name: 'Untitled customization' }, () => authorize(request)));
      return { extensionId: state.extension.id };
    });
    app.get('/api/shared-studio/:target', request => { noQuery(request); return readStudio(request); });
    app.get('/api/shared-studio/:target/history', request => {
      const [actor, key, lease] = context(request), before = Number(pageQuery(request));
      if (!Number.isSafeInteger(before) || before < 1) throw new AppError(400, 'Use an exact history cursor.');
      return lifecycleResponse(studio.older(actor, key, before, lease));
    });
    for (const command of ['turn', 'confirm', 'cancel', 'approve', 'activate', 'disable']) app.post(`/api/shared-studio/:target/${command}`, async (request, reply) => {
      noQuery(request);
      const [actor, key, lease] = context(request);
      if (['approve', 'activate', 'disable'].includes(command)) {
        if (!request.body || Object.keys(request.body).length !== 1 || typeof request.body.token !== 'string')
          throw new AppError(400, 'Use the exact reviewed draft.');
        await withSignal(request, reply, signal => studio.decide(actor, key, lease, command, request.body.token, signal));
      } else if (command === 'confirm') {
        const result = await withSignal(request, reply, signal => studio.confirm(actor, key, request.body, lease, signal));
        try { return studioResponse([actor, key, lease], result); }
        catch (cause) {
          if (cause?.status !== 409) throw cause;
          throw new AppError(503, 'Read the saved confirmation before continuing.');
        }
      } else await withSignal(request, reply, signal => studio[command](actor, key, request.body, lease, signal));
      return readStudio(request);
    });
  }
  for (const [path, method, bodyLimit] of [['proposals', 'propose', 16384], ['simulations', 'simulate', 32768]]) {
    app.post(`/api/projects/:id/capability/${path}`, { bodyLimit }, async (request, reply) => {
      noQuery(request); const actor = authorize(request).userId;
      if (method === 'propose' && !ai.team.savedWork(actor, request.params.id, authoringLease(request)).canContinue)
        throw new AppError(409, 'Start a new customization in Shared Studio.');
      const result = await withSignal(request, reply, signal => capability[method](
        actor, request.params.id, request.body, () => authorize(request).userId, { signal }));
      authorize(request); return result;
    });
  }
  app.get('/api/projects/:id/capability/operations/:operationId', request => {
    noQuery(request); const actor = authorize(request).userId;
    return capability.readOperation(actor, request.params.id, request.params.operationId, () => authorize(request).userId);
  });
  for (const [path, method] of [['approvals', 'approve'], ['activations', 'activate'], ['deactivations', 'deactivate'], ['revocations', 'revoke']]) {
    app.post(`/api/projects/:id/capability/${path}`, { bodyLimit: ['deactivations', 'revocations'].includes(path) ? 2048 : 40960 }, async (request, reply) => {
      noQuery(request); const actor = authorize(request).userId;
      const result = await withSignal(request, reply, signal => capability[method](
        actor, request.params.id, request.body, () => authorize(request).userId, { signal }));
      authorize(request); return result;
    });
  }
  app.patch('/api/projects/:id', request => service.renameProject(authorize(request).userId, request.params.id, request.body));
  app.get('/api/projects/:id/tasks', request => service.listTasks(authorize(request).userId, request.params.id));
  app.get('/api/projects/:id/tasks/search', request => service.searchTasks(authorize(request).userId, request.params.id, request.query));
  app.get('/api/tasks/:id', request => service.getTask(authorize(request).userId, request.params.id));
  const reactionHook = request => {
    const hook = request.query.trigger ?? TASK_HOOK;
    if (Object.keys(request.query).some(key => key !== 'trigger') || !TASK_EVENT_HOOKS.includes(hook)) throw new AppError(400, 'Choose a task trigger.');
    return hook;
  };
  const reaction = (actor, id, hook, method) => {
    const { project } = taskAccess(db, actor, id);
    return shared.reaction(actor, id, method === 'reconcile', hook)
      ?? (project.mode === 'TEAM' ? team : effects)[method](actor, id, hook);
  };
  app.get('/api/tasks/:id/reaction', request => reaction(authorize(request).userId, request.params.id, reactionHook(request), 'status'));
  app.post('/api/tasks/:id/reaction/reconcile', request => {
    const session = authorize(request), hook = reactionHook(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length) throw new AppError(400, 'Checking a saved outcome takes no fields.');
    return reaction(session.userId, request.params.id, hook, 'reconcile');
  });
  app.post('/api/tasks', async (request, reply) => {
    const owner = authorize(request).userId;
    const result = await withSignal(request, reply, signal => service.createTask(owner, request.body,
      { operationId: request.headers['x-task-create-id'], signal, authorize: () => authorize(request).userId }));
    authorize(request);
    wakeEffects(); reply.code(201); return result;
  });
  app.get('/api/task-create-operations/:operationId', request => {
    noQuery(request);
    return service.getCreateOperation(authorize(request).userId, request.params.operationId,
      { authorize: () => authorize(request).userId });
  });
  app.patch('/api/tasks/:id', request => service.editTask(authorize(request).userId, request.params.id, request.body));
  app.post('/api/tasks/:id/complete', async (request, reply) => {
    const session = authorize(request);
    if (!request.body || Object.keys(request.body).length) throw new AppError(400, 'Completion takes no fields.');
    const result = await withSignal(request, reply, signal => service.completeTask(session.userId, request.params.id,
      { signal, authorize: () => authorize(request).userId }));
    wakeEffects();
    return result;
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
