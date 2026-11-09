import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openData, taskService, taskEffectService } from '../src/data.mjs';
import { seedTaskEffectBinding, invocationFor } from './fixtures/task-effect-schema.mjs';

const owner = 'maya';
const denied = { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' };
const unavailable = { kind: 'TRANSIENT_FAILURE', effect: 'NONE' };

async function setup(t, guard = { commitReserveMs: 25, check: async () => ({ status: 'ALLOWED' }), current: () => true }) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const binding = seedTaskEffectBinding(db, owner);
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(binding.revisionId, JSON.stringify(binding.pins), owner);
  const source = await tasks.createTask(owner, { projectId, title: 'Guarded automation source' }, { operationId: randomUUID() });
  tasks.completeTask(owner, source.id);
  // The evaluator seam checks persisted selection identity; artifact execution has its own integration coverage.
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id=? AND hook_id='TaskBeforeCreate'")
    .run(binding.revisionId, JSON.stringify(binding.pins), owner);
  const effects = taskEffectService(db, { guard });
  const eventId = db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(source.id).event_id;
  const invocation = invocationFor(effects, owner, eventId), key = invocation.requestKey;
  assert.ok(effects.claim(owner, eventId, invocation));
  const request = { projectId, title: '  Guarded result  ', notes: 'Saved notes', tagsText: ' Client , review', priority: 'high' };
  const counts = () => ['tasks', 'task_events', 'task_effect_receipts'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const receipt = () => db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, key.value);
  const create = (input = request, context = invocation) => effects.createTaskOnce(owner, key, input, context);
  const changeSelection = () => db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id=? AND hook_id='TaskBeforeCreate'").run(owner);
  return { db, tasks, effects, source, binding, projectId, eventId, key, invocation, request, counts, receipt, create, changeSelection };
}

for (const [status, expected] of [['ALLOWED', null], ['DENIED', denied], ['BLOCKED', unavailable]]) {
  test(`automation creation retains a ${status} guard result without emitting TaskCreated`, async t => {
    const checks = [];
    const f = await setup(t, { commitReserveMs: 25,
      check: async context => { checks.push(context); return { status, message: 'Choose a due date.' }; }, current: () => true });
    const before = f.counts(), result = await f.create(), saved = f.receipt();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].owner, owner);
    assert.strictEqual(checks[0].requestKey, f.key);
    assert.deepEqual(checks[0].input, { projectId: f.projectId, priority: 'high', tags: ['client', 'review'], hasNotes: true, hasDueDate: false });
    assert.equal(checks[0].selection.revision_id, f.binding.revisionId);
    assert.equal(checks[0].selection.generation, 1);
    assert.equal(checks[0].selection.binding_pins, JSON.stringify(f.binding.pins));
    assert.equal(checks[0].deadline.expiresAtMs, 975);
    assert.deepEqual(JSON.parse(Buffer.from(saved.payload)), f.request);
    assert.equal(saved.result, JSON.stringify(result));
    assert.equal(saved.effect, result.effect);
    if (expected) {
      assert.deepEqual(result, expected);
      assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
      const details = JSON.parse(saved.guard_details);
      assert.equal(details.code, status === 'DENIED' ? 'TASK_CREATE_DENIED' : 'TASK_CREATE_UNAVAILABLE');
      assert.equal(typeof details.message, 'string');
      if (status === 'DENIED') assert.equal(details.message, 'Choose a due date.');
      assert.equal(saved.affected_task_id, null);
      assert.equal(saved.observation, null);
    } else {
      assert.deepEqual(result, { kind: 'SUCCESS', value: { id: result.value.id }, effect: 'CONFIRMED' });
      assert.deepEqual(f.counts(), [before[0] + 1, before[1], before[2] + 1]);
      const task = f.tasks.getTask(owner, result.value.id);
      assert.equal(task.title, 'Guarded result');
      assert.equal(task.notes, 'Saved notes');
      assert.deepEqual(task.tags, ['client', 'review']);
      assert.equal(task.priority, 'high');
      assert.equal(saved.guard_details, null);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(task.id).n, 0);
    }
    assert.equal(Object.hasOwn(f.effects.status(owner, f.eventId).receipt, 'guard_details'), false);
  });
}

for (const status of ['ALLOWED', 'DENIED', 'BLOCKED']) {
  test(`settled ${status} receipt replays before a changed guard and preserves its exact bytes`, async t => {
    let checks = 0;
    const guard = { commitReserveMs: 25, check: async () => { checks++; return { status }; }, current: () => true };
    const f = await setup(t, guard), result = await f.create(), saved = f.receipt(), after = f.counts();
    f.changeSelection();
    guard.check = async () => { throw new Error('Settled keys must not evaluate a new guard'); };
    guard.current = () => false;
    assert.deepEqual(await f.create({ ...f.request }), result);
    assert.deepEqual(await f.create({ ...f.request, title: 'Different bytes' }),
      { kind: 'BUSINESS_REJECTION', code: 'KEY_PAYLOAD_MISMATCH', effect: 'NONE' });
    assert.equal(checks, 1);
    assert.deepEqual(f.receipt(), saved);
    assert.deepEqual(f.counts(), after);
  });
}

for (const stale of [false, true]) {
  test(`a saved CONFIRMED receipt beats a held guard's late ${stale ? 'stale decision' : 'denial'}`, async t => {
    const held = Promise.withResolvers(), entered = Promise.withResolvers();
    let checks = 0;
    const late = { status: stale ? 'ALLOWED' : 'DENIED' };
    const f = await setup(t, { commitReserveMs: 25,
      check: async () => { if (++checks === 1) { entered.resolve(); return held.promise; } return { status: 'ALLOWED' }; },
      current: decision => decision !== late || !stale });
    const before = f.counts(), first = f.create();
    await entered.promise;
    assert.deepEqual(f.counts(), before);
    const winner = await f.create(), saved = f.receipt();
    assert.equal(winner.effect, 'CONFIRMED');
    held.resolve(late);
    assert.deepEqual(await first, winner);
    assert.deepEqual(f.receipt(), saved);
    assert.deepEqual(f.counts(), [before[0] + 1, before[1], before[2] + 1]);
    assert.equal(checks, 2);
  });
}

test('automation freezes the guard input and native proposal across the async check', async t => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  let checked;
  const f = await setup(t, { commitReserveMs: 25, check: async context => { checked = context; entered.resolve(); return held.promise; }, current: () => true });
  const original = { ...f.request }, pending = f.create();
  await entered.promise;
  assert.ok(Object.isFrozen(checked.input));
  assert.ok(Object.isFrozen(checked.input.tags));
  assert.ok(Object.isFrozen(checked.selection));
  assert.throws(() => { checked.input.priority = 'low'; }, TypeError);
  assert.throws(() => checked.input.tags.push('mutated'), TypeError);
  Object.assign(f.request, { projectId: f.tasks.listProjects('leo')[0].id, title: 'Mutated', notes: 'Changed', tagsText: 'changed', priority: 'low' });
  held.resolve({ status: 'ALLOWED' });
  const result = await pending, task = f.tasks.getTask(owner, result.value.id);
  assert.equal(task.projectId, original.projectId);
  assert.equal(task.title, original.title.trim());
  assert.equal(task.notes, original.notes);
  assert.deepEqual(task.tags, ['client', 'review']);
  assert.equal(task.priority, original.priority);
  assert.deepEqual(JSON.parse(Buffer.from(f.receipt().payload)), original);
});

test('an aborted parent check stores only an unavailable NONE receipt', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers(), controller = new AbortController();
  let checked;
  const f = await setup(t, { commitReserveMs: 25, check: async context => { checked = context; entered.resolve(); return held.promise; }, current: () => true });
  f.invocation.signal = controller.signal;
  const before = f.counts(), pending = f.create();
  await entered.promise;
  assert.strictEqual(checked.signal, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, unavailable);
  const saved = f.receipt();
  assert.equal(JSON.parse(saved.guard_details).code, 'TASK_CREATE_STALE');
  held.resolve({ status: 'ALLOWED' });
  await Promise.resolve();
  assert.deepEqual(f.receipt(), saved);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
});

for (const expiredAt of [975, 1000]) {
  test(`guard completion at ${expiredAt} respects the parent's deadline and commit reserve`, async t => {
    let now = 0;
    const f = await setup(t, { commitReserveMs: 25, check: async () => { now = expiredAt; return { status: 'ALLOWED' }; }, current: () => true });
    f.invocation.deadline.clock.nowMs = () => now;
    const before = f.counts();
    if (expiredAt === 1000) {
      await assert.rejects(f.create, { code: 'AUTHORITY_DENIED' });
      assert.deepEqual(f.counts(), before);
      assert.equal(f.receipt(), undefined);
      assert.notEqual(f.effects.status(owner, f.eventId).revokedAt, null);
    } else {
      assert.deepEqual(await f.create(), unavailable);
      assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
    }
  });
}

for (const status of ['ALLOWED', 'DENIED', 'BLOCKED']) {
  test(`receipt insertion failure rolls back a ${status} guard result atomically`, async t => {
    let checks = 0;
    const f = await setup(t, { commitReserveMs: 25, check: async () => { checks++; return { status }; }, current: () => true });
    const before = f.counts();
    f.db.exec("CREATE TEMP TRIGGER fail_guard_receipt BEFORE INSERT ON task_effect_receipts BEGIN SELECT RAISE(ABORT,'guard receipt blocked'); END");
    await assert.rejects(f.create, /guard receipt blocked/);
    assert.deepEqual(f.counts(), before);
    assert.equal(f.receipt(), undefined);
    assert.equal(f.effects.status(owner, f.eventId).state, 'STARTED');
    f.db.exec('DROP TRIGGER fail_guard_receipt');
    const retried = await f.create();
    assert.equal(retried.effect, status === 'ALLOWED' ? 'CONFIRMED' : 'NONE');
    assert.equal(checks, 2);
    assert.deepEqual(f.counts(), [before[0] + (status === 'ALLOWED' ? 1 : 0), before[1], before[2] + 1]);
  });
}

for (const phase of ['during check', 'after task insert', 'after receipt insert']) {
  test(`selection changes ${phase} fail closed without creating a task or event`, async t => {
    const held = Promise.withResolvers(), entered = Promise.withResolvers();
    const f = await setup(t, { commitReserveMs: 25, check: async () => { entered.resolve(); return held.promise; }, current: () => true });
    const before = f.counts();
    if (phase !== 'during check') f.db.exec(`CREATE TEMP TRIGGER change_guard_selection AFTER INSERT ON ${phase === 'after task insert' ? 'tasks' : 'task_effect_receipts'} BEGIN
      UPDATE extension_selections SET generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskBeforeCreate'; END`);
    const pending = f.create();
    await entered.promise;
    if (phase === 'during check') f.changeSelection();
    held.resolve({ status: 'ALLOWED' });
    assert.deepEqual(await pending, unavailable);
    assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1]);
    assert.equal(JSON.parse(f.receipt().guard_details).code, 'TASK_CREATE_STALE');
    assert.equal(f.receipt().affected_task_id, null);
  });
}
