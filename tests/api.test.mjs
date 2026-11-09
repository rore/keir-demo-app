import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskEffectService, taskService } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { seedTaskEffectBinding, invocationFor } from './fixtures/task-effect-schema.mjs';

const origin = 'http://127.0.0.1:32123';
const databases = new WeakMap();
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keir-native-api-'));
  const db = openData(join(dir, 'app.sqlite'));
  return createApp({ db, origin, staticRoot: dir }).then(app => {
    databases.set(app, db);
    t.after(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    return app;
  });
}
const request = (method, url, { cookie, token, body, headers = {} } = {}) => ({
  method, url, headers: { host: '127.0.0.1:32123', ...(cookie ? { cookie: `keir_demo_session=${cookie}` } : {}), ...(token ? { 'x-session-context': token } : {}),
    ...(method === 'POST' && url === '/api/tasks' ? { 'x-task-create-id': randomUUID() } : {}), ...headers },
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
});

test('an admitted owner A completion keeps its exact native context after the browser signs in as B', async t => {
  const app = await setup(t), db = databases.get(app);
  const bootstrap = await app.inject(request('GET', '/api/session'));
  const maya = await signIn(app, 'maya', bootstrap.json().contextToken);
  const { revisionId, pins } = seedTaskEffectBinding(db);
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'")
    .run(revisionId, JSON.stringify(pins));
  const projects = await app.inject(request('GET', '/api/projects', maya)), projectId = projects.json()[0].id;
  const source = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId, title: 'Owner A source' }, headers: jsonHeaders }));
  assert.equal(source.statusCode, 201);
  // Let the creation route's dispatcher wake finish before recording the held completion.
  await new Promise(resolve => setImmediate(resolve));
  // Hold dispatch until after the session switch while creating the normal native event.
  assert.equal(taskService(db).completeTask('maya', source.json().id).status, 'completed');
  const eventId = db.prepare('SELECT event_id FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(source.json().id).event_id;
  const leo = await signIn(app, 'leo', maya);
  const effects = taskEffectService(db), invocation = invocationFor(effects, 'maya', eventId);
  const captured = effects.contextFor('maya', invocation);
  assert.equal(captured.owner, 'maya'); assert.equal(captured.sourceTaskId, source.json().id);
  assert.deepEqual(effects.claim('maya', eventId, invocation).pins, pins);
  const result = await effects.createTaskOnce('maya', invocation.requestKey, { projectId, title: 'Owner A result' }, invocation);
  assert.equal(result.effect, 'CONFIRMED');
  const foreignRead = await app.inject(request('GET', `/api/tasks/${result.value.id}`, leo));
  assert.equal(foreignRead.statusCode, 404);
  const switchedBack = await signIn(app, 'maya', leo);
  const ownRead = await app.inject(request('GET', `/api/tasks/${result.value.id}`, switchedBack));
  assert.equal(ownRead.statusCode, 200); assert.equal(ownRead.json().title, 'Owner A result');
  assert.equal(effects.status('maya', eventId).originalKey, captured.originalKey);
});
const jsonHeaders = { origin, 'content-type': 'application/json' };
async function signIn(app, userId, context) {
  const previous = typeof context === 'string' ? { token: context } : context;
  const response = await app.inject(request('POST', '/api/session', { ...previous, body: { userId }, headers: jsonHeaders }));
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: response.cookies.find(cookie => cookie.name === 'keir_demo_session').value, token: response.json().contextToken };
}

test('same-origin session context protects CRUD and rejects cross-user and stale requests', async t => {
  const app = await setup(t);
  const bootstrap = await app.inject(request('GET', '/api/session'));
  assert.equal(bootstrap.statusCode, 200);
  assert.deepEqual(bootstrap.json().users.map(user => user.id), ['maya', 'leo', 'sam']);
  const maya = await signIn(app, 'maya', bootstrap.json().contextToken);
  const projectResponse = await app.inject(request('POST', '/api/projects', { ...maya, body: { name: 'API project' }, headers: jsonHeaders }));
  assert.equal(projectResponse.statusCode, 201, projectResponse.body);
  const project = projectResponse.json();
  assert.equal(Object.hasOwn(project, 'ownerId'), false);
  const taskResponse = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId: project.id, title: 'API task', ownerId: 'leo' }, headers: jsonHeaders }));
  assert.equal(taskResponse.statusCode, 400);
  const dueAt = '2028-02-29T17:42:37.123Z';
  const task = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId: project.id, title: 'API task', notes: 'start', tags: ['review'], priority: 'high', dueAt }, headers: jsonHeaders }));
  assert.equal(task.statusCode, 201, task.body);
  assert.deepEqual([task.json().tags, task.json().priority, task.json().dueAt], [['review'], 'high', dueAt]);
  const patch = body => app.inject(request('PATCH', `/api/tasks/${task.json().id}`, { ...maya, body, headers: jsonHeaders }));
  assert.equal((await patch({ priority: 'normal', dueAt: '2027-02-29T17:42:37.123Z' })).statusCode, 400);
  const edited = await patch({ dueAt: null });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual([edited.json().priority, edited.json().dueAt, edited.json().notes], ['high', null, 'start']);
  const completed = await app.inject(request('POST', `/api/tasks/${task.json().id}/complete`, { ...maya, body: {}, headers: jsonHeaders }));
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().status, 'completed');
  assert.ok(completed.json().completedAt);
  const repeated = await app.inject(request('POST', `/api/tasks/${task.json().id}/complete`, { ...maya, body: {}, headers: jsonHeaders }));
  assert.deepEqual(repeated.json(), completed.json());
  assert.deepEqual(Object.keys(completed.json()).sort(), ['completedAt','createdAt','dueAt','id','notes','priority','projectId','status','tags','title','updatedAt']);
  const protectedKey = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId: project.id, title: 'No public key', operationKey: 'forged' }, headers: jsonHeaders }));
  assert.equal(protectedKey.statusCode, 400);

  const leo = await signIn(app, 'leo', maya);
  const foreignAssociation = await app.inject(request('POST', '/api/tasks', { ...leo, body: { projectId: project.id, title: 'wrong owner' }, headers: jsonHeaders }));
  assert.equal(foreignAssociation.statusCode, 404);
  const foreignEdit = await app.inject(request('PATCH', `/api/tasks/${task.json().id}`, { ...leo, body: { priority: 'low', dueAt }, headers: jsonHeaders }));
  assert.equal(foreignEdit.statusCode, 404);
  for (const [method, url] of [['GET', `/api/tasks/${task.json().id}`], ['PATCH', `/api/projects/${project.id}`]]) {
    const response = await app.inject(request(method, url, { ...leo, body: method === 'PATCH' ? { name: 'stolen' } : undefined, headers: method === 'PATCH' ? jsonHeaders : {} }));
    assert.equal(response.statusCode, 404, response.body);
  }
  const wrongContext = await app.inject(request('GET', '/api/projects', { cookie: leo.cookie, token: maya.token }));
  assert.equal(wrongContext.statusCode, 401);
  assert.equal(wrongContext.headers['set-cookie'], undefined);
  const staleCookie = await app.inject(request('GET', '/api/projects', maya));
  assert.equal(staleCookie.statusCode, 401);
  assert.equal(staleCookie.headers['set-cookie'], undefined);
});

test('API rejects bad host/origin/content type, oversized body, unknown identity and unscoped access', async t => {
  const app = await setup(t);
  const bootstrap = await app.inject(request('GET', '/api/session'));
  const anon = bootstrap.json().contextToken;
  const unauth = await app.inject(request('GET', '/api/projects'));
  assert.equal(unauth.statusCode, 401);
  const badHost = await app.inject({ ...request('GET', '/api/session'), headers: { host: 'localhost:32123' } });
  assert.equal(badHost.statusCode, 403);
  const unknown = await app.inject(request('POST', '/api/session', { token: anon, body: { userId: 'admin' }, headers: jsonHeaders }));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.headers['set-cookie'], undefined);
  for (const headers of [{ 'content-type': 'text/plain', origin }, { 'content-type': 'application/json' }, { 'content-type': 'application/json', origin: 'http://localhost:32123' }]) {
    const bad = await app.inject(request('POST', '/api/session', { token: anon, body: { userId: 'maya' }, headers }));
    assert.ok([403, 415].includes(bad.statusCode), `${bad.statusCode}: ${bad.body}`);
  }
  const oversized = await app.inject({ ...request('POST', '/api/session', { token: anon, headers: jsonHeaders }), payload: JSON.stringify({ userId: 'maya', padding: 'x'.repeat(30_000) }) });
  assert.equal(oversized.statusCode, 413);
  const signed = await signIn(app, 'maya', anon);
  const querySpoof = await app.inject(request('GET', '/api/projects?ownerId=leo', signed));
  assert.equal(querySpoof.statusCode, 200);
  assert.deepEqual(querySpoof.json().map(project => project.name), ['The spring collection']);
});

test('session switching revokes the old cookie and ordinary stale API responses never change cookies', async t => {
  const app = await setup(t);
  const bootstrap = (await app.inject(request('GET', '/api/session'))).json();
  const maya = await signIn(app, 'maya', bootstrap.contextToken);
  const leo = await signIn(app, 'leo', maya);
  const stale = await app.inject(request('GET', '/api/projects', maya));
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.headers['set-cookie'], undefined);
  const current = await app.inject(request('GET', '/api/projects', leo));
  assert.equal(current.statusCode, 200);
  assert.equal(current.headers['set-cookie'], undefined);
});

test('project search and native tag edits use the current owner and strict query fields', async t => {
  const app = await setup(t);
  const bootstrap = await app.inject(request('GET', '/api/session'));
  const maya = await signIn(app, 'maya', bootstrap.json().contextToken);
  const projects = await app.inject(request('GET', '/api/projects', maya));
  const [{ id: projectId }] = projects.json();
  const search = (query, session = maya, id = projectId) =>
    app.inject(request('GET', `/api/projects/${id}/tasks/search${query}`, session));
  const post = (url, body) => app.inject(request('POST', url, { ...maya, body, headers: jsonHeaders }));
  const other = await post('/api/projects', { name: 'Other project' });
  assert.equal(other.statusCode, 201, other.body);
  const foreignAnchor = await post('/api/tasks', { projectId: other.json().id, title: 'Search target', tags: ['ready'] });
  assert.equal(foreignAnchor.statusCode, 201, foreignAnchor.body);
  const created = await post('/api/tasks', { projectId, title: 'Search target', tags: [' Ready '] });
  assert.equal(created.statusCode, 201, created.body);
  const task = created.json();
  assert.deepEqual(task.tags, ['ready']);
  const patched = await app.inject(request('PATCH', `/api/tasks/${task.id}`, {
    ...maya, headers: jsonHeaders, body: { tags: [' follow-up '] },
  }));
  assert.equal(patched.statusCode, 200, patched.body);
  const found = await search('?q=TARGET&tag=FOLLOW-UP');
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json(), { items: [patched.json()], nextAfter: null });
  assert.equal(found.json().items[0].title, task.title);

  for (const query of ['', '?q=%20', '?tag=follow-up&tag=ready', '?q=target&q=target', '?q=target&ownerId=leo',
    '?q=target&after=', '?q=target&after=has%20space', '?q=target&after=a&after=b']) {
    const response = await search(query);
    assert.equal(response.statusCode, 400, query);
  }
  assert.equal((await search('?q=target', {})).statusCode, 401);
  const missing = await search('?q=target&after=missing');
  const wrongProject = await search('?q=target&after=' + foreignAnchor.json().id);
  assert.equal(missing.statusCode, 404);
  assert.equal(wrongProject.statusCode, 404);
  assert.deepEqual(wrongProject.json(), missing.json());
  const leo = await signIn(app, 'leo', maya);
  assert.equal((await search('?q=target', leo)).statusCode, 404);
  const leoProjects = await app.inject(request('GET', '/api/projects', leo));
  const foreignOwner = await search('?q=target&after=' + task.id, leo, leoProjects.json()[0].id);
  assert.equal(foreignOwner.statusCode, 404);
  assert.deepEqual(foreignOwner.json(), missing.json());
});
