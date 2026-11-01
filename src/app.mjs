import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError, USERS, taskService } from './data.mjs';

const nonce = () => randomBytes(32).toString('hex');
const COOKIE = 'keir_demo_session';

export async function createApp({ db, origin, staticRoot = resolve('dist') }) {
  const url = new URL(origin);
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024, requestTimeout: 10_000, connectionTimeout: 10_000, ajv: { customOptions: { removeAdditional: false } } });
  const sessions = new Map();
  const anonymousContext = nonce();
  const service = taskService(db);
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
    reply.code(status).send({ message: status >= 500 ? 'Something could not be saved. Please try again.' : error.message });
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
  app.post('/api/projects', (request, reply) => { const result = service.createProject(authorize(request).userId, request.body); reply.code(201); return result; });
  app.patch('/api/projects/:id', request => service.renameProject(authorize(request).userId, request.params.id, request.body));
  app.get('/api/projects/:id/tasks', request => service.listTasks(authorize(request).userId, request.params.id));
  app.get('/api/tasks/:id', request => service.getTask(authorize(request).userId, request.params.id));
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
