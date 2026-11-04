import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskEffectService } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';

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
  method, url, headers: { host: '127.0.0.1:32123', ...(cookie ? { cookie: `keir_demo_session=${cookie}` } : {}), ...(token ? { 'x-session-context': token } : {}), ...headers },
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
});

test('an admitted owner A completion keeps its exact native context after the browser signs in as B', async t => {
  const app = await setup(t), db = databases.get(app);
  const bootstrap = await app.inject(request('GET', '/api/session'));
  const maya = await signIn(app, 'maya', bootstrap.json().contextToken);
  const selected = db.prepare("SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='ClassifyTask'").get();
  const pins = { artifactDigest: `sha256:${'a'.repeat(64)}`, modelRef: { format: 'keir-dcm/effect-3', digest: `sha256:${'b'.repeat(64)}` },
    compiler: { id: 'test' }, environment: { id: 'test' }, consumer: { kind: 'EVENT_REPORT' },
    qualification: { id: 'test-report', revision: 1, reportDigest: `sha256:${'c'.repeat(64)}`, hostBuild: `sha256:${'d'.repeat(64)}` } };
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'")
    .run(selected.revision_id, JSON.stringify(pins));
  const projects = await app.inject(request('GET', '/api/projects', maya)), projectId = projects.json()[0].id;
  const source = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId, title: 'Owner A source' }, headers: jsonHeaders }));
  assert.equal(source.statusCode, 201);
  const completed = await app.inject(request('POST', `/api/tasks/${source.json().id}/complete`, { ...maya, body: {}, headers: jsonHeaders }));
  assert.equal(completed.statusCode, 200);
  const eventId = db.prepare('SELECT event_id FROM task_completion_events WHERE source_task_id=?').get(source.json().id).event_id;
  const leo = await signIn(app, 'leo', maya);
  const seen = [];
  const effects = taskEffectService(db, { authorizeRead: context => context.owner === 'maya',
    authorizeWrite: context => { seen.push(context); return context.owner === 'maya'; }, isQualificationCurrent: context => context.pins.qualification.id === 'test-report' });
  assert.deepEqual(effects.claim('maya', eventId).pins, pins);
  const result = effects.createTaskOnce('maya', effects.keyFor('maya', eventId), { projectId, title: 'Owner A result' });
  assert.equal(result.effect, 'CONFIRMED'); assert.ok(seen.every(context => context.owner === 'maya' && context.sourceTaskId === source.json().id));
  const foreignRead = await app.inject(request('GET', `/api/tasks/${result.value.id}`, leo));
  assert.equal(foreignRead.statusCode, 404);
  const switchedBack = await signIn(app, 'maya', leo);
  const ownRead = await app.inject(request('GET', `/api/tasks/${result.value.id}`, switchedBack));
  assert.equal(ownRead.statusCode, 200); assert.equal(ownRead.json().title, 'Owner A result');
  assert.equal(effects.status('maya', eventId).originalKey, seen[0].originalKey);
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
  const task = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId: project.id, title: 'API task', notes: 'start' }, headers: jsonHeaders }));
  assert.equal(task.statusCode, 201, task.body);
  const completed = await app.inject(request('POST', `/api/tasks/${task.json().id}/complete`, { ...maya, body: {}, headers: jsonHeaders }));
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().status, 'completed');
  assert.ok(completed.json().completedAt);
  const repeated = await app.inject(request('POST', `/api/tasks/${task.json().id}/complete`, { ...maya, body: {}, headers: jsonHeaders }));
  assert.deepEqual(repeated.json(), completed.json());
  assert.deepEqual(Object.keys(completed.json()).sort(), ['completedAt','createdAt','id','notes','projectId','status','title','updatedAt']);
  const protectedKey = await app.inject(request('POST', '/api/tasks', { ...maya, body: { projectId: project.id, title: 'No public key', operationKey: 'forged' }, headers: jsonHeaders }));
  assert.equal(protectedKey.statusCode, 400);

  const leo = await signIn(app, 'leo', maya);
  const foreignAssociation = await app.inject(request('POST', '/api/tasks', { ...leo, body: { projectId: project.id, title: 'wrong owner' }, headers: jsonHeaders }));
  assert.equal(foreignAssociation.statusCode, 404);
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
