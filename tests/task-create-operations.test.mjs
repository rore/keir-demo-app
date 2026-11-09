import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup as backupDatabase } from 'node:sqlite';
import { openData, resetData, taskService } from '../src/data.mjs';
import { seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

const owner = 'maya';
const allowed = () => ({ status: 'ALLOWED' });
const defaultGuard = () => ({ commitReserveMs: 25, check: async () => allowed(), current: () => true });
const unresolved = operationId => ({ operationId, state: 'UNRESOLVED' });

const directory = () => mkdtempSync(join(tmpdir(), 'task-create-operations-'));

function fixture(t, { guard = defaultGuard(), path = ':memory:' } = {}) {
  const db = openData(path);
  t.after(() => db.close());
  const tasks = taskService(db, { guard });
  const projectId = tasks.listProjects(owner)[0].id;
  const input = { projectId, title: 'Original task' };
  const context = { operationId: randomUUID(), deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
  const select = () => {
    const binding = seedTaskEffectBinding(db, owner);
    db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id='TaskBeforeCreate'")
      .run(binding.revisionId, JSON.stringify(binding.pins), owner);
    return binding;
  };
  const counts = () => ['tasks', 'task_events', 'task_create_operations'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const row = () => db.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, context.operationId);
  const create = (proposal = input, metadata = context) => tasks.createTask(owner, proposal, metadata);
  const read = () => tasks.getCreateOperation(owner, context.operationId);
  return { db, tasks, input, context, select, counts, row, create, read };
}

function assertNotCreated(error, operationId, code) {
  assert.equal(error.operationId, operationId);
  assert.equal(error.state, 'NOT_CREATED');
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  return true;
}

test('a committed response survives reopen and same-ID replay inserts only one task and event', async t => {
  const dir = directory(), path = join(dir, 'app.sqlite');
  let db = openData(path);
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  const tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const input = { projectId, title: 'Response lost after commit', notes: 'Saved once' }, operationId = randomUUID();
  const before = db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  const saved = await tasks.createTask(owner, input, { operationId });
  const original = db.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, operationId);
  db.close(); db = null;
  db = openData(path);
  const reopened = taskService(db);
  assert.deepEqual(reopened.getCreateOperation(owner, operationId), { operationId, state: 'CREATED', task: saved });
  assert.deepEqual(await reopened.createTask(owner, input, { operationId }), saved);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, before + 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(saved.id).n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, operationId), original);
});

test('canonical defaults and native normalization identify the complete same candidate', async t => {
  const f = fixture(t), before = f.counts();
  const saved = await f.create({ ...f.input, title: '  Original task  ' });
  const explicit = { dueAt: null, priority: 'normal', tags: [], notes: '', title: 'Original task', projectId: f.input.projectId };
  assert.deepEqual(await f.create(explicit), saved);
  const row = f.row();
  assert.ok(row.candidate instanceof Uint8Array);
  assert.ok(row.result instanceof Uint8Array);
  assert.deepEqual(JSON.parse(Buffer.from(row.candidate)), explicit);
  assert.deepEqual(JSON.parse(Buffer.from(row.result)), { state: 'CREATED', task: saved });
  for (const changed of [{ title: 'Different' }, { notes: 'Different' }, { tags: ['client'] }, { priority: 'high' }, { dueAt: '2026-04-01T12:00:00.000Z' }]) {
    await assert.rejects(() => f.create({ ...explicit, ...changed }), { status: 409, code: 'CREATE_PAYLOAD_MISMATCH' });
    assert.deepEqual(f.row(), row);
  }
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  const other = await f.create(explicit, { operationId: randomUUID() });
  assert.notEqual(other.id, saved.id);
});

test('candidate bytes retain embedded NULs and accepted native Unicode without conflating payloads', async t => {
  const f = fixture(t), input = { ...f.input, notes: 'before\u0000after\ud800', tags: [' Client ', 'client', 'Review'] };
  await f.create(input);
  const candidate = JSON.parse(Buffer.from(f.row().candidate));
  assert.equal(candidate.notes, input.notes);
  assert.deepEqual(candidate.tags, ['client', 'review']);
  await f.create({ ...input, tags: ['client', 'review'] });
  await assert.rejects(() => f.create({ ...input, notes: 'before\u0000different\ud800' }), { code: 'CREATE_PAYLOAD_MISMATCH' });
});

for (const [status, code, httpStatus] of [['DENIED', 'RULE_DENIED', 422], ['BLOCKED', 'CHECK_UNAVAILABLE', 503]]) {
  test(`confirmed ${code} is durable and a changed rule cannot rewrite that attempt`, async t => {
    let checks = 0;
    const guard = { commitReserveMs: 25, check: async () => { checks++; return { status, message: 'Add a due date.' }; }, current: () => true };
    const f = fixture(t, { guard }); f.select();
    const before = f.counts();
    await assert.rejects(f.create, error => assertNotCreated(error, f.context.operationId, code) && error.status === httpStatus);
    const result = f.read(), row = f.row();
    assert.equal(result.state, 'NOT_CREATED');
    assert.equal(result.code, code);
    assert.equal(result.operationId, f.context.operationId);
    if (status === 'DENIED') assert.equal(result.message, 'Add a due date.');
    guard.check = async () => { checks++; return allowed(); };
    await assert.rejects(f.create, error => assertNotCreated(error, f.context.operationId, code));
    await assert.rejects(() => f.create({ ...f.input, notes: 'Correction' }), { code: 'CREATE_PAYLOAD_MISMATCH' });
    assert.equal(checks, 1);
    assert.deepEqual(f.row(), row);
    assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
    const next = await f.create({ ...f.input, notes: 'Correction' }, { ...f.context, operationId: randomUUID() });
    assert.equal(next.notes, 'Correction');
  });
}

for (const firstStatus of ['ALLOWED', 'DENIED']) {
  test(`two connections retain the first committed result when a held ${firstStatus} finishes late`, async t => {
    const dir = directory(), path = join(dir, 'app.sqlite'), entered = Promise.withResolvers(), held = Promise.withResolvers();
    let checks = 0;
    const guard = { commitReserveMs: 25, check: async () => { if (++checks === 1) { entered.resolve(); return held.promise; } return allowed(); }, current: () => true };
    const f = fixture(t, { path, guard }); f.select();
    const otherDb = openData(path); t.after(() => otherDb.close());
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const other = taskService(otherDb, { guard }), before = f.counts();
    const late = f.create(); await entered.promise;
    assert.deepEqual(f.read(), unresolved(f.context.operationId));
    const winner = await other.createTask(owner, f.input, f.context), row = f.row();
    held.resolve({ status: firstStatus });
    assert.deepEqual(await late, winner);
    assert.deepEqual(f.read(), { operationId: f.context.operationId, state: 'CREATED', task: winner });
    assert.deepEqual(f.row(), row);
    assert.deepEqual(f.counts(), before.map(n => n + 1));
  });
}

test('a committed denial beats a concurrent late ALLOW and its readback remains immutable', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  let checks = 0;
  const f = fixture(t, { guard: { commitReserveMs: 25,
    check: async () => { if (++checks === 1) { entered.resolve(); return held.promise; } return { status: 'DENIED', message: 'Keep the denial.' }; }, current: () => true } });
  f.select();
  const before = f.counts(), late = f.create(); await entered.promise;
  await assert.rejects(f.create, error => assertNotCreated(error, f.context.operationId, 'RULE_DENIED'));
  const row = f.row();
  held.resolve(allowed());
  await assert.rejects(() => late, error => assertNotCreated(error, f.context.operationId, 'RULE_DENIED'));
  assert.deepEqual(f.row(), row);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
});

test('task edits and deletion preserve the original creation snapshot without resurrection', async t => {
  const f = fixture(t), original = await f.create(), row = f.row();
  f.tasks.editTask(owner, original.id, { title: 'Later title', notes: 'Later notes' });
  assert.deepEqual(await f.create(), original);
  assert.equal(f.tasks.getTask(owner, original.id).title, 'Later title');
  f.db.prepare('DELETE FROM task_events WHERE source_task_id=?').run(original.id);
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(original.id);
  const before = f.counts();
  assert.deepEqual(f.read(), { operationId: f.context.operationId, state: 'CREATED', task: original });
  assert.deepEqual(await f.create(), original);
  assert.throws(() => f.tasks.getTask(owner, original.id), { status: 404 });
  assert.deepEqual(f.row(), row);
  assert.deepEqual(f.counts(), before);
});

for (const state of ['CREATED', 'NOT_CREATED']) {
  test(`${state} readback and replay require current access to the original project`, async t => {
    const f = fixture(t, { guard: { commitReserveMs: 25, check: async () => ({ status: 'DENIED', message: 'Private rule message' }), current: () => true } });
    f.input.projectId = f.tasks.createProject(owner, { name: 'Private original project' }).id;
    if (state === 'NOT_CREATED') { f.select(); await assert.rejects(f.create); }
    else await f.create();
    const row = f.row();
    f.db.prepare('DELETE FROM task_events WHERE source_task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(f.input.projectId);
    f.db.prepare('DELETE FROM tasks WHERE project_id=?').run(f.input.projectId);
    f.db.prepare('DELETE FROM projects WHERE id=?').run(f.input.projectId);
    const before = f.counts();
    assert.throws(f.read, error => error.status === 404 && !Object.hasOwn(error, 'state') && !error.message.includes('Private'));
    await assert.rejects(f.create, error => error.status === 404 && !Object.hasOwn(error, 'state') && !error.message.includes('Private'));
    assert.deepEqual(f.row(), row);
    assert.deepEqual(f.counts(), before);
  });
}

test('another owner sees UNRESOLVED and an absent ID never proves no creation', async t => {
  const f = fixture(t);
  assert.deepEqual(f.read(), unresolved(f.context.operationId));
  await f.create();
  const before = f.counts();
  assert.deepEqual(f.tasks.getCreateOperation('leo', f.context.operationId), unresolved(f.context.operationId));
  await assert.rejects(() => f.tasks.createTask('leo', f.input, f.context), { status: 404 });
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.tasks.getCreateOperation(owner, randomUUID()).state, 'UNRESOLVED');
});

test('missing or malformed operation IDs fail before guard evaluation or persistence', async t => {
  let checks = 0;
  const f = fixture(t, { guard: { ...defaultGuard(), check: async () => { checks++; return allowed(); } } }); f.select();
  const before = f.counts();
  for (const operationId of [undefined, null, '', 'not-a-uuid', 1, {}, randomUUID() + ' ']) {
    await assert.rejects(() => f.create(f.input, { operationId }), { status: 400 });
    assert.throws(() => f.tasks.getCreateOperation(owner, operationId), { status: 400 });
  }
  await assert.rejects(() => f.tasks.createTask(owner, f.input), { status: 400 });
  assert.equal(checks, 0);
  assert.deepEqual(f.counts(), before);
});

test('unnormalizable input leaves no terminal result and cannot cancel the same pending ID', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  const f = fixture(t, { guard: { commitReserveMs: 25, check: async () => { entered.resolve(); return held.promise; }, current: () => true } }); f.select();
  const before = f.counts(), pending = f.create(); await entered.promise;
  for (const input of [{ ...f.input, title: '' }, { ...f.input, tags: ['1','2','3','4','5','6','7','8','9'] }, { ...f.input, dueAt: 'tomorrow' }, { ...f.input, operationId: f.context.operationId }])
    await assert.rejects(() => f.create(input), { status: 400 });
  assert.deepEqual(f.read(), unresolved(f.context.operationId));
  assert.deepEqual(f.counts(), before);
  held.resolve(allowed());
  assert.equal((await pending).title, f.input.title);
  assert.deepEqual(f.counts(), before.map(n => n + 1));
});

for (const status of ['ALLOWED', 'DENIED']) {
  test(`terminal result INSERT failure rolls back a ${status} attempt and leaves readback unresolved`, async t => {
    const f = fixture(t, { guard: { commitReserveMs: 25, check: async () => ({ status }), current: () => true } }); f.select();
    const before = f.counts();
    f.db.exec("CREATE TEMP TRIGGER fail_create_operation BEFORE INSERT ON task_create_operations BEGIN SELECT RAISE(ABORT,'operation result blocked'); END");
    await assert.rejects(f.create, /operation result blocked/);
    assert.deepEqual(f.counts(), before);
    assert.deepEqual(f.read(), unresolved(f.context.operationId));
  });
}

for (const phase of ['during check', 'after task insert', 'after result insert']) {
  test(`a session change ${phase} cannot commit task, event or result`, async t => {
    let session = owner;
    const f = fixture(t, { guard: { commitReserveMs: 25, check: async () => { if (phase === 'during check') session = 'leo'; return allowed(); }, current: () => true } }); f.select();
    f.context.authorize = () => session;
    if (phase !== 'during check') {
      f.db.function('change_operation_session', () => { session = 'leo'; });
      f.db.exec(`CREATE TEMP TRIGGER change_session AFTER INSERT ON ${phase === 'after task insert' ? 'tasks' : 'task_create_operations'} BEGIN SELECT change_operation_session(); END`);
    }
    const before = f.counts();
    await assert.rejects(f.create, { status: 401 });
    assert.deepEqual(f.counts(), before);
    assert.deepEqual(f.read(), unresolved(f.context.operationId));
  });
}

test('stored readback and POST replay reject an invalid session without exposing the terminal envelope', async t => {
  const f = fixture(t); await f.create();
  const row = f.row(), context = { authorize: () => 'leo' };
  assert.throws(() => f.tasks.getCreateOperation(owner, f.context.operationId, context), error => error.status === 401 && !Object.hasOwn(error, 'task') && !Object.hasOwn(error, 'state'));
  await assert.rejects(() => f.create(f.input, { ...f.context, ...context }), { status: 401 });
  assert.deepEqual(f.row(), row);
});

test('session loss while reading a stored result cannot disclose its snapshot', async t => {
  const f = fixture(t); await f.create();
  let session = owner;
  const prepare = f.db.prepare;
  f.db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!sql.startsWith('SELECT') || !sql.includes('FROM task_create_operations')) return statement;
    return { get(...args) { const row = statement.get(...args); session = 'leo'; return row; } };
  };
  try {
    assert.throws(() => f.tasks.getCreateOperation(owner, f.context.operationId, { authorize: () => session }), { status: 401 });
    session = owner;
    await assert.rejects(() => f.create(f.input, { ...f.context, authorize: () => session }), { status: 401 });
  } finally { f.db.prepare = prepare; }
});

test('a selection change records a terminal stale attempt and never silently rechecks that ID', async t => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  let checks = 0;
  const f = fixture(t, { guard: { commitReserveMs: 25, check: async () => { checks++; entered.resolve(); return held.promise; }, current: () => true } }); f.select();
  const before = f.counts(), pending = f.create(); await entered.promise;
  f.db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id=? AND hook_id='TaskBeforeCreate'").run(owner);
  held.resolve(allowed());
  await assert.rejects(() => pending, error => assertNotCreated(error, f.context.operationId, 'STALE_ATTEMPT'));
  const row = f.row();
  await assert.rejects(f.create, error => assertNotCreated(error, f.context.operationId, 'STALE_ATTEMPT'));
  assert.equal(checks, 1);
  assert.deepEqual(f.row(), row);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
});

for (const condition of ['expired', 'aborted']) {
  test(`an authorized ${condition} parent records confirmed NOT_CREATED without native writes`, async t => {
    const f = fixture(t); f.select();
    if (condition === 'expired') f.context.deadline.clock.nowMs = () => 1000;
    else { const controller = new AbortController(); controller.abort(); f.context.signal = controller.signal; }
    const before = f.counts();
    await assert.rejects(f.create, error => assertNotCreated(error, f.context.operationId, 'STALE_ATTEMPT'));
    assert.equal(f.read().state, 'NOT_CREATED');
    assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
  });
}

test('stored operation results reject mutation', async t => {
  const f = fixture(t); await f.create(); const row = f.row();
  for (const column of ['candidate', 'result']) assert.throws(() => f.db.prepare(`UPDATE task_create_operations SET ${column}=? WHERE owner_id=? AND operation_id=?`)
    .run(Buffer.from('{}'), owner, f.context.operationId), /immutable/i);
  assert.deepEqual(f.row(), row);
});

test('real isolated reset backs up operation records, clears them and rejects the old project binding', async t => {
  const dir = directory(), path = join(dir, 'app.sqlite'), operationId = randomUUID();
  let db = openData(path);
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  let tasks = taskService(db);
  const input = { projectId: tasks.listProjects(owner)[0].id, title: 'Before full reset' };
  const original = await tasks.createTask(owner, input, { operationId });
  const row = db.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, operationId);
  db.close(); db = null;
  await assert.rejects(() => resetData(dir, true, async (source, backupPath) => {
    await backupDatabase(source, backupPath);
    const copy = openData(backupPath);
    try { copy.exec('DELETE FROM task_create_operations'); } finally { copy.close(); }
  }), /Backup differs/);
  const backupPath = await resetData(dir, true);
  const backup = openData(backupPath);
  try {
    assert.deepEqual(taskService(backup).getCreateOperation(owner, operationId), { operationId, state: 'CREATED', task: original });
    assert.deepEqual(backup.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, operationId), row);
  } finally { backup.close(); }
  db = openData(path); tasks = taskService(db);
  assert.equal(tasks.listProjects(owner).some(project => project.id === input.projectId), false);
  assert.deepEqual(tasks.getCreateOperation(owner, operationId), unresolved(operationId));
  const before = db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  await assert.rejects(() => tasks.createTask(owner, input, { operationId }), { status: 404 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n, 0);
});
