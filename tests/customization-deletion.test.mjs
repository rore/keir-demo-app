import test from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createApp } from '../src/app.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { runTaskEffectSimulation } from '../src/task-effect-simulation.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const authorize = () => {};
const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = state => ({ extensionId: state.extension.id, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation });
const handles = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function setup(t, options = {}) {
  const db = openData(':memory:'); t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler, ...options }) };
}
function add(db, lifecycle, id, owner = 'maya') {
  return admitTaskDraft(db, lifecycle, { owner, extensionId: id, operationId: id, name: id }).state;
}
async function taskDraft(db, lifecycle, id, fixture) {
  const state = add(db, lifecycle, id);
  const loaded = await lifecycle.compile('maya', { extensionId: id, hookId: 'TaskCompleted', source: fixture.source, draftVersion: state.draftVersion }, authorize);
  return lifecycle.proposeScenarios('maya', { ...handles(loaded), cases: fixture.cases }, authorize);
}

test('selected deletion disables once, keeps audit/native rows and rejects every saved link and restore path', async t => {
  const { db, lifecycle } = setup(t);
  const fixture = await compileTaskCustomization();
  let state = await taskDraft(db, lifecycle, 'selected-task', fixture);
  state = await lifecycle.simulate('maya', handles(state), authorize);
  state = lifecycle.approve('maya', { ...handles(state), evidenceId: state.evidence.id }, authorize);
  state = lifecycle.activate('maya', { ...handles(state), generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, authorize);
  const previous = state.selection.revision;
  const tables = ['tasks', 'projects', 'extension_revisions', 'extension_revision_links', 'extension_authored', 'extension_evidence', 'extension_approvals', 'authoring_budget'];
  const before = Object.fromEntries(tables.map(table => [table, rows(db, table)]));
  const other = lifecycle.collection('leo');
  const history = rows(db, 'extension_history');
  const receipt = lifecycle.delete('maya', input(state), authorize);
  assert.equal(receipt.extensionId, state.extension.id); assert.ok(receipt.deletedAt >= 0);
  assert.deepEqual(lifecycle.delete('maya', input(state), authorize), receipt, 'lost response is safely repeatable with old fences');
  const after = lifecycle.collection('maya');
  assert.equal(after.items.some(item => item.extension.id === state.extension.id), false); assert.equal(after.selection.revision, null);
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
    () => lifecycle.approve('maya', { ...handles(state), evidenceId: state.evidence.id }, authorize),
    () => lifecycle.activate('maya', { ...handles(state), generation: after.selection.generation, evidenceId: state.approvedEvidenceId }, authorize),
    () => lifecycle.rollback('maya', { extensionId: receipt.extensionId, revisionId: previous.id, generation: after.selection.generation }, authorize),
    () => lifecycle.restart('maya', { extensionId: receipt.extensionId, revisionId: previous.id, draftVersion: state.draftVersion, generation: after.selection.generation }, authorize),
  ];
  for (const work of unavailable) assert.throws(work, { status: 404 });
  assert.ok(lifecycle.history('maya').rows.every(row => row.revisionId !== state.draft.id), 'normal global history excludes deleted entries without removing retained audit');
});

test('unselected deletion preserves the active Task selection', async t => {
  const { db, lifecycle } = setup(t);
  const fixture = await compileTaskCustomization();
  let active = await taskDraft(db, lifecycle, 'active-task', fixture);
  active = await lifecycle.simulate('maya', handles(active), authorize);
  active = lifecycle.approve('maya', { ...handles(active), evidenceId: active.evidence.id }, authorize);
  active = lifecycle.activate('maya', { ...handles(active), generation: active.selection.generation, evidenceId: active.approvedEvidenceId }, authorize);
  const extra = add(db, lifecycle, 'unselected');
  const before = lifecycle.collection('maya').selection;
  lifecycle.delete('maya', input(extra), authorize);
  assert.deepEqual(lifecycle.collection('maya').selection, before);
  assert.equal(lifecycle.source('maya', active.draft.id, active.extension.id).source, fixture.source);
});

test('exact names, draft and global selection fences reject stale confirmation; denied authority rolls back deletion', t => {
  const { db, lifecycle } = setup(t), state = add(db, lifecycle, 'delete-fences'), retained = rows(db, 'extensions');
  for (const override of [{ expectedName: 'Different' }, { draftVersion: 1 }, { generation: 1 }]) {
    assert.throws(() => lifecycle.delete('maya', { ...input(state), ...override }, authorize), { status: 409 });
    assert.deepEqual(rows(db, 'extensions'), retained);
  }
  let calls = 0;
  assert.throws(() => lifecycle.delete('maya', input(state), () => { if (++calls === 2) throw Object.assign(new Error('expired'), { status: 401 }); }), { status: 401 });
  assert.deepEqual(rows(db, 'extensions'), retained);
  assert.equal(lifecycle.state('maya', state.extension.id).selection.generation, state.selection.generation);
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

test('late Task compile, scenario validation and simulation cannot save after deletion', async t => {
  const fixture = await compileTaskCustomization(), gate = deferred(), entered = deferred();
  const { db, lifecycle } = setup(t, { compiler: { compile: async (...args) => { entered.resolve(); await gate.promise; return compiler.compile(...args); } } });
  const state = add(db, lifecycle, 'compile-target'), count = rows(db, 'extension_revisions').length;
  const pending = lifecycle.compile('maya', { extensionId: state.extension.id, hookId: 'TaskCompleted', source: fixture.source, draftVersion: 0 }, authorize);
  await entered.promise; lifecycle.delete('maya', input(state), authorize); gate.resolve();
  await assert.rejects(pending, { status: 404 }); assert.equal(rows(db, 'extension_revisions').length, count);
  const regular = createLifecycle(db, { compiler });
  const authored = await taskDraft(db, regular, 'scenario-target', fixture);
  let checks = 0;
  const scenario = regular.proposeScenarios('maya', { ...handles(authored), cases: fixture.cases }, () => {
    if (++checks === 2) regular.delete('maya', input(authored), authorize);
  });
  await assert.rejects(scenario, { status: 404 });
  const simGate = deferred(), simEntered = deferred();
  const held = createLifecycle(db, { compiler, runTaskSimulation: async (...args) => {
    simEntered.resolve(); await simGate.promise; return runTaskEffectSimulation(...args);
  } });
  const loaded = await taskDraft(db, held, 'simulation-target', fixture);
  const evidenceCount = rows(db, 'extension_evidence').length;
  const simulation = held.simulate('maya', handles(loaded), authorize); await simEntered.promise;
  held.delete('maya', input(loaded), authorize); simGate.resolve();
  await assert.rejects(simulation, { status: 404 }); assert.equal(rows(db, 'extension_evidence').length, evidenceCount);
});

test('current creation receipts remain owner-scoped and report deletion without recompiling', async t => {
  const fixture = await compileTaskCustomization();
  let calls = 0;
  const { db, lifecycle } = setup(t, { compiler: { compile: async (...args) => { calls++; return compiler.compile(...args); } } });
  const state = await taskDraft(db, lifecycle, 'original', fixture);
  const receipt = lifecycle.findCreation('maya', 'original').creationReceipt;
  assert.equal(receipt.extensionId, state.extension.id);
  assert.equal(receipt.draftVersion, 1);
  assert.deepEqual(lifecycle.findCreation('maya', 'original').creationReceipt, receipt);
  assert.throws(() => lifecycle.findCreation('leo', 'original'), { status: 404 });
  lifecycle.delete('maya', input(state), authorize);
  assert.throws(() => lifecycle.findCreation('maya', 'original'), { status: 410, code: 'CUSTOMIZATION_DELETED' });
  assert.equal(calls, 1);
});

test('API deletion enforces exact body, origin/session and owner; repeat receipt does not expose deleted content', async t => {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin, compiler }); t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers }, ...(payload === undefined ? {} : { payload }) });
  const state = add(db, createLifecycle(db), 'delete-api'), path = `extensions/${state.extension.id}/delete`, body = { ...input(state) }; delete body.extensionId;
  assert.equal((await call(path, body)).statusCode, 401);
  const bootstrap = (await call('session')).json();
  const login = await call('session', { userId: 'maya' }, { 'x-session-context': bootstrap.contextToken });
  auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-session-context': login.json().contextToken };
  for (const bad of [null, [], {}, { ...body, extra: true }, { ...body, expectedName: 1 }, { ...body, draftVersion: -1 }, { ...body, generation: 1.5 }]) assert.equal((await call(path, bad)).statusCode, 400);
  assert.equal((await call(path + '?extra=x', body)).statusCode, 400);
  assert.equal((await call(path, body, { origin: 'http://foreign.invalid' })).statusCode, 403);
  assert.equal((await call(path, body, { 'x-session-context': 'old' })).statusCode, 401);
  const foreign = add(db, createLifecycle(db), 'delete-foreign', 'leo');
  assert.equal((await call(`extensions/${foreign.extension.id}/delete`, body)).statusCode, 404);
  assert.equal((await call('extensions/missing/delete', body)).statusCode, 404);
  assert.equal((await call(path, { ...body, generation: body.generation + 1 })).statusCode, 409);
  const deleted = await call(path, body); assert.equal(deleted.statusCode, 200);
  assert.deepEqual(Object.keys(deleted.json()).sort(), ['deletedAt', 'extensionId']);
  assert.deepEqual((await call(path, body)).json(), deleted.json());
  assert.equal((await call(`extensions/${state.extension.id}`)).statusCode, 404);
  assert.deepEqual((await call('extensions')).json().items, []);
});
