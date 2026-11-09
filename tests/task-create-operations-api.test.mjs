import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { openData, taskService } from '../src/data.mjs';

const origin = 'http://127.0.0.1:32123';
const allowed = () => ({ status: 'ALLOWED' });
const readPath = id => '/api/task-create-operations/' + id;

async function fixture(t, guard) {
  const directory = mkdtempSync(join(tmpdir(), 'task-create-api-'));
  const db = openData(':memory:');
  const app = await createApp({ db, origin, staticRoot: directory, compiler: {}, guard });
  t.after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (method, url, { auth, body, operationId } = {}) => app.inject({ method, url,
    headers: { host: '127.0.0.1:32123',
      ...(auth ? { cookie: `keir_demo_session=${auth.cookie}`, 'x-session-context': auth.token } : {}),
      ...(body !== undefined ? { origin, 'content-type': 'application/json' } : {}),
      ...(method === 'POST' && url === '/api/tasks' && operationId !== undefined ? { 'x-task-create-id': operationId } : {}),
    }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  async function signIn(owner, previous) {
    const token = previous?.token ?? (await request('GET', '/api/session')).json().contextToken;
    const response = await request('POST', '/api/session', { auth: { cookie: previous?.cookie ?? '', token }, body: { userId: owner } });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: response.cookies.find(row => row.name === 'keir_demo_session').value, token: response.json().contextToken };
  }
  const auth = await signIn('maya');
  const projects = await request('GET', '/api/projects', { auth });
  assert.equal(projects.statusCode, 200, projects.body);
  const input = { projectId: projects.json()[0].id, title: 'Original creation' };
  // The trusted fake evaluator tests HTTP/native coordination, not packaged rule execution.
  const select = () => {
    const revisionId = randomUUID();
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, 'maya', 'authored', '{}', 'customer');
    db.prepare("UPDATE extension_selections SET revision_id=?,binding_pins='{}',generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskBeforeCreate'").run(revisionId);
  };
  const counts = () => ['tasks', 'task_events', 'task_create_operations']
    .map(table => db.prepare('SELECT count(*) AS n FROM ' + table).get().n);
  const create = (body = input, operationId = randomUUID(), session = auth) => request('POST', '/api/tasks', { auth: session, body, operationId });
  const read = (id, session = auth) => request('GET', readPath(id), { auth: session });
  return { app, db, request, signIn, auth, input, select, counts, create, read };
}

function ordinaryError(response, status) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(typeof response.json().message, 'string');
  for (const key of ['operationId', 'state', 'task']) assert.equal(Object.hasOwn(response.json(), key), false);
}

test('missing or malformed creation IDs fail before evaluating the guard or writing rows', async t => {
  let checks = 0;
  const f = await fixture(t, { commitReserveMs: 20, check: async () => { checks++; return allowed(); }, current: () => true });
  f.select();
  const before = f.counts();
  // Use the raw request helper so omission is not replaced by the create helper's fresh ID.
  ordinaryError(await f.request('POST', '/api/tasks', { auth: f.auth, body: f.input }), 400);
  for (const operationId of ['', 'not-a-uuid', randomUUID() + ' ', '00000000-0000-0000-0000-000000000000']) {
    ordinaryError(await f.request('POST', '/api/tasks', { auth: f.auth, body: f.input, operationId }), 400);
  }
  const id = randomUUID();
  ordinaryError(await f.create({ ...f.input, operationId: id }, id), 400);
  assert.equal(checks, 0);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual((await f.read(id)).json(), { operationId: id, state: 'UNRESOLVED' });
});

test('canonical replay returns the original 201 DTO and saves one task, event and result', async t => {
  const f = await fixture(t), id = randomUUID(), before = f.counts();
  const first = await f.create({ ...f.input, title: '  Original creation  ', tags: [' Client ', 'client'] }, id);
  assert.equal(first.statusCode, 201, first.body);
  const task = first.json();
  assert.equal(task.title, 'Original creation');
  assert.deepEqual(task.tags, ['client']);
  assert.equal(Object.hasOwn(task, 'state'), false);
  assert.equal(Object.hasOwn(task, 'operationId'), false);
  const explicit = { ...f.input, notes: '', tags: ['client'], priority: 'normal', dueAt: null };
  const replay = await f.create(explicit, id);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), task);
  const readback = await f.read(id);
  assert.equal(readback.statusCode, 200, readback.body);
  assert.deepEqual(readback.json(), { operationId: id, state: 'CREATED', task });
  assert.equal(readback.headers['cache-control'], 'no-store');
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM task_events WHERE source_task_id=? AND hook_id='TaskCreated'").get(task.id).n, 1);
});

test('a mismatched candidate is an ordinary 409 and cannot replace the saved result', async t => {
  const f = await fixture(t), id = randomUUID();
  const first = await f.create(f.input, id);
  assert.equal(first.statusCode, 201, first.body);
  const original = (await f.read(id)).json(), before = f.counts();
  for (const change of [{ title: 'Different' }, { notes: 'Different' }, { tags: ['review'] }, { priority: 'high' }, { dueAt: '2026-04-01T12:00:00.000Z' }]) {
    const response = await f.create({ ...f.input, ...change }, id);
    ordinaryError(response, 409);
    assert.equal(response.json().code, 'CREATE_PAYLOAD_MISMATCH');
    assert.deepEqual((await f.read(id)).json(), original);
    assert.deepEqual(f.counts(), before);
  }
});

test('readback requires the current session, exact UUID and no query fields', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.create(f.input, id);
  const before = f.counts();
  ordinaryError(await f.request('GET', readPath(id)), 401);
  ordinaryError(await f.read(id, { ...f.auth, token: 'wrong-context' }), 401);
  ordinaryError(await f.request('GET', readPath(id) + '?owner=maya', { auth: f.auth }), 400);
  ordinaryError(await f.request('GET', readPath('not-a-uuid'), { auth: f.auth }), 400);
  const leo = await f.signIn('leo');
  const foreign = await f.read(id, leo);
  assert.equal(foreign.statusCode, 200, foreign.body);
  assert.deepEqual(foreign.json(), { operationId: id, state: 'UNRESOLVED' });
  ordinaryError(await f.create(f.input, id, leo), 404);
  ordinaryError(await f.create(f.input, id, { ...f.auth, token: 'wrong-context' }), 401);
  assert.deepEqual(f.counts(), before);
});

for (const [status, code, message, check] of [
  [422, 'RULE_DENIED', '<b>A due date is required</b>', async () => ({ status: 'DENIED', message: '<b>A due date is required</b>' })],
  [503, 'CHECK_UNAVAILABLE', 'The task rule could not be checked. Your entries are kept.', async () => { throw Error('private provider detail'); }],
]) test(code + ' returns a distinct durable NOT_CREATED envelope', async t => {
  let checks = 0;
  const f = await fixture(t, { commitReserveMs: 20, check: (...args) => { checks++; return check(...args); }, current: () => true });
  f.select();
  const id = randomUUID(), before = f.counts();
  const expected = { operationId: id, state: 'NOT_CREATED', code, message };
  const first = await f.create(f.input, id);
  assert.equal(first.statusCode, status, first.body);
  assert.deepEqual(first.json(), expected);
  const readback = await f.read(id);
  assert.equal(readback.statusCode, 200, readback.body);
  assert.deepEqual(readback.json(), expected);
  const replay = await f.create(f.input, id);
  assert.equal(replay.statusCode, status, replay.body);
  assert.deepEqual(replay.json(), expected);
  assert.equal(checks, 1);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
});

test('readback during held evaluation is exactly UNRESOLVED with no provisional task or result', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  const f = await fixture(t, { commitReserveMs: 20, check: async () => { entered.resolve(); return held.promise; }, current: () => true });
  f.select();
  const id = randomUUID(), before = f.counts(), pending = f.create(f.input, id);
  await entered.promise;
  const readback = await f.read(id);
  assert.equal(readback.statusCode, 200, readback.body);
  assert.deepEqual(readback.json(), { operationId: id, state: 'UNRESOLVED' });
  assert.deepEqual(f.counts(), before);
  held.resolve(allowed());
  const response = await pending;
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(f.counts(), before.map(n => n + 1));
});

test('a selection change during evaluation returns durable STALE_ATTEMPT without creating a task', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  const f = await fixture(t, { commitReserveMs: 20, check: async () => { entered.resolve(); return held.promise; }, current: () => true });
  f.select();
  const id = randomUUID(), before = f.counts(), pending = f.create(f.input, id);
  await entered.promise;
  f.db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskBeforeCreate'").run();
  held.resolve(allowed());
  const response = await pending;
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { operationId: id, state: 'NOT_CREATED', code: 'STALE_ATTEMPT',
    message: 'The task rule changed. Check it again before adding this task.' });
  assert.deepEqual((await f.read(id)).json(), response.json());
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
});

test('switching the session during a held check returns 401 and commits no task, event or result', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  const f = await fixture(t, { commitReserveMs: 20, check: async () => { entered.resolve(); return held.promise; }, current: () => true });
  f.select();
  const id = randomUUID(), before = f.counts(), pending = f.create(f.input, id);
  await entered.promise;
  const leo = await f.signIn('leo', f.auth);
  held.resolve(allowed());
  ordinaryError(await pending, 401);
  assert.deepEqual(f.counts(), before);
  ordinaryError(await f.read(id), 401);
  const maya = await f.signIn('maya', leo);
  assert.deepEqual((await f.read(id, maya)).json(), { operationId: id, state: 'UNRESOLVED' });
});

test('POST replay and readback keep the creation snapshot after native edits and deletion', async t => {
  const f = await fixture(t), id = randomUUID();
  const response = await f.create(f.input, id);
  assert.equal(response.statusCode, 201, response.body);
  const original = response.json();
  const edited = await f.request('PATCH', '/api/tasks/' + original.id, { auth: f.auth, body: { title: 'Later title', notes: 'Later notes' } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await f.request('GET', '/api/tasks/' + original.id, { auth: f.auth })).json().title, 'Later title');
  assert.deepEqual((await f.create(f.input, id)).json(), original);
  assert.deepEqual((await f.read(id)).json(), { operationId: id, state: 'CREATED', task: original });
  // Simulate native cleanup; replay must not resurrect the task after its linked event is removed.
  f.db.prepare('DELETE FROM task_events WHERE source_task_id=?').run(original.id);
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(original.id);
  const before = f.counts(), replay = await f.create(f.input, id);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), original);
  assert.deepEqual((await f.read(id)).json(), { operationId: id, state: 'CREATED', task: original });
  ordinaryError(await f.request('GET', '/api/tasks/' + original.id, { auth: f.auth }), 404);
  assert.deepEqual(f.counts(), before);
});

for (const state of ['CREATED', 'NOT_CREATED']) test('lost project access hides the saved ' + state + ' result on GET and POST', async t => {
  const f = await fixture(t, { commitReserveMs: 20, check: async () => ({ status: 'DENIED', message: 'Private rule message' }), current: () => true });
  f.input.projectId = taskService(f.db).createProject('maya', { name: 'Private original project' }).id;
  if (state === 'NOT_CREATED') f.select();
  const id = randomUUID(), response = await f.create(f.input, id);
  assert.equal(response.statusCode, state === 'CREATED' ? 201 : 422, response.body);
  if (state === 'CREATED') {
    f.db.prepare('DELETE FROM task_events WHERE source_task_id=?').run(response.json().id);
    f.db.prepare('DELETE FROM tasks WHERE id=?').run(response.json().id);
  }
  f.db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run('leo', f.input.projectId);
  const before = f.counts();
  const readback = await f.read(id), replay = await f.create(f.input, id);
  ordinaryError(readback, 404);
  ordinaryError(replay, 404);
  assert.deepEqual(readback.json(), replay.json());
  assert.equal(readback.body.includes('Private rule message'), false);
  assert.equal(readback.body.includes('Original creation'), false);
  assert.deepEqual(f.counts(), before);
});
