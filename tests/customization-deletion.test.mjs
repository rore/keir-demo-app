import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openData, transaction } from '../src/data.mjs';
import { createLifecycle, simulationCases } from '../src/extension-lifecycle.mjs';
import { createTaskRead } from '../src/task-read.mjs';
import { createApp } from '../src/app.mjs';
import { runReadSimulation } from '@keir/runtime-node/read-simulation';

const authorize = () => {};
const artifact = readFileSync(new URL('../extensions/task-read/maya.json', import.meta.url));
const source = readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8');
const compiler = { compile: async () => ({ artifact, diagnostics: [] }) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = state => ({ extensionId: state.extension.id, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation });
const handles = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function setup(t, options = {}) {
  const db = openData(':memory:'); t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler, ...options }) };
}
function first(lifecycle, owner = 'maya') { return lifecycle.state(owner, lifecycle.collection(owner).items[0].extension.id); }
function add(db, lifecycle, id, owner = 'maya') {
  return transaction(db, () => lifecycle.admit(owner, { extensionId: id, operationId: id,
    hash: 'sha256:' + 'a'.repeat(64), name: id }, authorize));
}

test('selected deletion disables once, keeps audit/native rows and rejects every saved link and restore path', async t => {
  const { db, lifecycle } = setup(t);
  let state = first(lifecycle), previous = state.selection.revision;
  state = lifecycle.load('maya', { extensionId: state.extension.id, templateId: 'pending', draftVersion: 0 }, authorize);
  state = await lifecycle.simulate('maya', handles(state), authorize);
  state = lifecycle.approve('maya', { ...handles(state), evidenceId: state.evidence.id }, authorize);
  const tables = ['tasks', 'projects', 'extension_revisions', 'extension_revision_links', 'extension_authored', 'extension_evidence', 'extension_approvals', 'authoring_budget'];
  const before = Object.fromEntries(tables.map(table => [table, rows(db, table)]));
  const other = lifecycle.collection('leo');
  const history = rows(db, 'extension_history');
  const receipt = lifecycle.delete('maya', input(state), authorize);
  assert.equal(receipt.extensionId, state.extension.id); assert.ok(receipt.deletedAt >= 0);
  assert.deepEqual(lifecycle.delete('maya', input(state), authorize), receipt, 'lost response is safely repeatable with old fences');
  const after = lifecycle.collection('maya');
  assert.deepEqual(after.items, []); assert.equal(after.selection.revision, null);
  assert.equal(after.selection.generation, state.selection.generation + 1);
  assert.deepEqual(lifecycle.collection('leo'), other);
  for (const table of tables) assert.deepEqual(rows(db, table), before[table], table);
  assert.equal(rows(db, 'extension_history').length, history.length + 1);
  assert.equal(rows(db, 'extension_history').at(-1).operation, 'disable');
  assert.equal(lifecycle.capture('maya'), null);
  const unavailable = [
    () => lifecycle.state('maya', receipt.extensionId),
    () => lifecycle.source('maya', state.draft.id, receipt.extensionId),
    () => lifecycle.evidence('maya', state.evidence.id, receipt.extensionId),
    () => lifecycle.history('maya', undefined, receipt.extensionId),
    () => lifecycle.revisionPage('maya', receipt.extensionId),
    () => lifecycle.evidencePage('maya', receipt.extensionId),
    () => lifecycle.restorePage('maya', receipt.extensionId),
    () => lifecycle.rename('maya', { extensionId: receipt.extensionId, name: 'New', expectedName: state.extension.name }, authorize),
    () => lifecycle.load('maya', { extensionId: receipt.extensionId, templateId: 'attention', draftVersion: state.draftVersion }, authorize),
    () => lifecycle.approve('maya', { ...handles(state), evidenceId: state.evidence.id }, authorize),
    () => lifecycle.activate('maya', { ...handles(state), generation: after.selection.generation }, authorize),
    () => lifecycle.rollback('maya', { extensionId: receipt.extensionId, revisionId: previous.id, generation: after.selection.generation }, authorize),
    () => lifecycle.restart('maya', { extensionId: receipt.extensionId, revisionId: previous.id, draftVersion: state.draftVersion, generation: after.selection.generation }, authorize),
  ];
  for (const work of unavailable) assert.throws(work, { status: 404 });
  assert.deepEqual(lifecycle.history('maya').rows, [], 'normal global history excludes deleted entries without removing retained audit');
});

test('unselected deletion preserves unrelated selection and held native advice; selected deletion suppresses held advice', async t => {
  const { db, lifecycle } = setup(t), state = first(lifecycle);
  const extra = add(db, lifecycle, 'unselected');
  const gate = deferred(), entered = deferred();
  const read = createTaskRead({ lifecycle, clock: { nowMs: () => 0 }, getTask: async (_, id) => {
    entered.resolve(); await gate.promise; return { id, status: 'open' };
  } });
  const waiting = read({ userId: 'maya', taskId: 'task', authorize: () => true }); await entered.promise;
  const before = lifecycle.collection('maya').selection;
  lifecycle.delete('maya', input(extra), authorize);
  assert.deepEqual(lifecycle.collection('maya').selection, before);
  gate.resolve(); assert.equal((await waiting).classification, 'PENDING');
  const nextGate = deferred(), nextEntered = deferred();
  const heldRead = createTaskRead({ lifecycle, clock: { nowMs: () => 0 }, getTask: async (_, id) => {
    nextEntered.resolve(); await nextGate.promise; return { id, status: 'open' };
  } });
  const pending = heldRead({ userId: 'maya', taskId: 'task', authorize: () => true }); await nextEntered.promise;
  lifecycle.delete('maya', input(state), authorize); nextGate.resolve();
  assert.equal((await pending).status, 'NOT_DISPLAYED');
  assert.equal((await heldRead({ userId: 'maya', taskId: 'task', authorize: () => true })).status, 'NOT_DISPLAYED');
});

test('exact names, draft and global selection fences reject stale confirmation; denied authority rolls back deletion', t => {
  const { db, lifecycle } = setup(t), state = first(lifecycle), retained = rows(db, 'extensions');
  for (const override of [{ expectedName: 'Different' }, { draftVersion: 1 }, { generation: 0 }]) {
    assert.throws(() => lifecycle.delete('maya', { ...input(state), ...override }, authorize), { status: 409 });
    assert.deepEqual(rows(db, 'extensions'), retained);
  }
  let calls = 0;
  assert.throws(() => lifecycle.delete('maya', input(state), () => { if (++calls === 2) throw Object.assign(new Error('expired'), { status: 401 }); }), { status: 401 });
  assert.deepEqual(rows(db, 'extensions'), retained);
  assert.equal(lifecycle.collection('maya').selection.generation, state.selection.generation);
  const legacyName = 'Legacy\0name';
  db.prepare('UPDATE extensions SET name=? WHERE id=?').run(legacyName, state.extension.id);
  assert.throws(() => lifecycle.delete('maya', input(state), authorize), { status: 409 });
  assert.equal(lifecycle.delete('maya', { ...input(state), expectedName: legacyName }, authorize).extensionId, state.extension.id);
});

test('collection cursors still resolve when their anchor is deleted and deleted rows do not consume page limits', t => {
  const { db, lifecycle } = setup(t);
  for (let n = 0; n < 45; n++) add(db, lifecycle, 'item-' + String(n).padStart(2, '0'));
  db.prepare('UPDATE extensions SET created_at=1 WHERE owner_id=?').run('maya');
  const page = lifecycle.collection('maya'); assert.equal(page.items.length, 20); assert.ok(page.next);
  lifecycle.delete('maya', input(lifecycle.state('maya', page.items.at(-1).extension.id)), authorize);
  lifecycle.delete('maya', input(lifecycle.state('maya', 'item-00')), authorize);
  const next = lifecycle.collection('maya', { before: page.next });
  assert.equal(next.items.length, 20); assert.ok(next.items.every(item => !page.items.some(prior => prior.extension.id === item.extension.id)));
  assert.ok(!next.items.some(item => item.extension.id === 'item-00'));
});

test('late compile, scenario validation and simulation cannot save after deletion', async t => {
  const gate = deferred(), entered = deferred();
  const { db, lifecycle } = setup(t, { compiler: { compile: async () => { entered.resolve(); await gate.promise; return { artifact, diagnostics: [] }; } } });
  const state = add(db, lifecycle, 'compile-target'), count = rows(db, 'extension_revisions').length;
  const pending = lifecycle.compile('maya', { extensionId: state.extension.id, source, draftVersion: 0 }, authorize);
  await entered.promise; lifecycle.delete('maya', input(state), authorize); gate.resolve();
  await assert.rejects(pending, { status: 404 }); assert.equal(rows(db, 'extension_revisions').length, count);
  const regular = createLifecycle(db, { compiler });
  const authored = await regular.createFromSource('maya', { operationId: 'scenario-target', source }, authorize);
  const scenario = regular.proposeScenarios('maya', { ...handles(authored), cases: [simulationCases('pending')[0].bytes.toString()] }, authorize);
  regular.delete('maya', input(authored), authorize);
  await assert.rejects(scenario, { status: 404 });
  const simGate = deferred(), simEntered = deferred();
  const held = createLifecycle(db, { runSimulation: async (...args) => { simEntered.resolve(); await simGate.promise; return runReadSimulation(...args); } });
  let loaded = add(db, held, 'simulation-target');
  loaded = held.load('maya', { extensionId: loaded.extension.id, templateId: 'pending', draftVersion: 0 }, authorize);
  const evidenceCount = rows(db, 'extension_evidence').length;
  const simulation = held.simulate('maya', handles(loaded), authorize); await simEntered.promise;
  held.delete('maya', input(loaded), authorize); simGate.resolve();
  await assert.rejects(simulation, { status: 404 }); assert.equal(rows(db, 'extension_evidence').length, evidenceCount);
});

test('creation receipts return terminal deletion without recompiling; mismatched operations still conflict and new creation works', async t => {
  let calls = 0;
  const { lifecycle } = setup(t, { compiler: { compile: async () => { calls++; return { artifact, diagnostics: [] }; } } });
  const request = { operationId: 'original', source };
  const state = await lifecycle.createFromSource('sam', request, authorize); assert.equal(calls, 1);
  lifecycle.delete('sam', input(state), authorize);
  assert.throws(() => lifecycle.findCreation('sam', 'original'), { status: 410, code: 'CUSTOMIZATION_DELETED' });
  await assert.rejects(lifecycle.createFromSource('sam', request, authorize), { status: 410, code: 'CUSTOMIZATION_DELETED' });
  await assert.rejects(lifecycle.createFromSource('sam', { ...request, source: source + '\n' }, authorize), { status: 409 });
  assert.equal(calls, 1);
  await lifecycle.createFromSource('sam', { ...request, operationId: 'new-explicit' }, authorize); assert.equal(calls, 2);
  assert.throws(() => lifecycle.findCreation('leo', 'original'), { status: 404 });
});

test('API deletion enforces exact body, origin/session and owner; repeat receipt does not expose deleted content', async t => {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin, compiler }); t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers }, ...(payload === undefined ? {} : { payload }) });
  const state = first(createLifecycle(db)), path = `extensions/${state.extension.id}/delete`, body = { ...input(state) }; delete body.extensionId;
  assert.equal((await call(path, body)).statusCode, 401);
  const bootstrap = (await call('session')).json();
  const login = await call('session', { userId: 'maya' }, { 'x-session-context': bootstrap.contextToken });
  auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-session-context': login.json().contextToken };
  for (const bad of [null, [], {}, { ...body, extra: true }, { ...body, expectedName: 1 }, { ...body, draftVersion: -1 }, { ...body, generation: 1.5 }]) assert.equal((await call(path, bad)).statusCode, 400);
  assert.equal((await call(path + '?extra=x', body)).statusCode, 400);
  assert.equal((await call(path, body, { origin: 'http://foreign.invalid' })).statusCode, 403);
  assert.equal((await call(path, body, { 'x-session-context': 'old' })).statusCode, 401);
  const foreign = first(createLifecycle(db), 'leo');
  assert.equal((await call(`extensions/${foreign.extension.id}/delete`, body)).statusCode, 404);
  assert.equal((await call('extensions/missing/delete', body)).statusCode, 404);
  assert.equal((await call(path, { ...body, generation: 0 })).statusCode, 409);
  const deleted = await call(path, body); assert.equal(deleted.statusCode, 200);
  assert.deepEqual(Object.keys(deleted.json()).sort(), ['deletedAt', 'extensionId']);
  assert.deepEqual((await call(path, body)).json(), deleted.json());
  assert.equal((await call(`extensions/${state.extension.id}`)).statusCode, 404);
  assert.deepEqual((await call('extensions')).json().items, []);
});
