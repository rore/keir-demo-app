import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openData, taskService } from '../src/data.mjs';

const owner = 'maya';
const allowed = () => ({ status: 'ALLOWED' });

test('prewrite read checks allow the intended insert to change its own open-match predicate', async t => {
  let f;
  let matchedBeforeWrite;
  f = fixture(t, { commitReserveMs: 20, check: async () => allowed(), current(_decision, phase) {
    if (phase === 'AFTER_WRITE') return true;
    matchedBeforeWrite = f.tasks.hasOpenTask(owner, f.input.projectId, f.input.title, f.context.deadline).matches;
    return !matchedBeforeWrite;
  } });
  f.select();
  const saved = await f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() });
  assert.equal(f.tasks.getTask(owner, saved.id).title, f.input.title);
  assert.equal(matchedBeforeWrite, false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM task_events WHERE source_task_id=? AND hook_id='TaskCreated'").get(saved.id).n, 1);
});

function fixture(t, guard = { commitReserveMs: 20, check: async () => allowed(), current: () => true }) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const tasks = taskService(db, { guard });
  const input = { projectId: tasks.listProjects(owner)[0].id, title: 'New task' };
  const context = { deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
  const select = () => {
    const revisionId = randomUUID();
    // This fixture tests the native coordinator seam; its evaluator supplies current authority.
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, owner, 'authored', '{}', 'customer');
    db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins='{}' WHERE owner_id=? AND hook_id='TaskBeforeCreate'")
      .run(revisionId, owner);
    return revisionId;
  };
  const saved = () => ['tasks', 'task_events', 'task_effect_receipts']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { db, tasks, input, context, select, saved };
}

test('unbound creation saves one task and its TaskCreated event atomically', async t => {
  const f = fixture(t, { check() { assert.fail('An unbound create must not evaluate a rule'); } });
  const before = f.saved();
  const task = await f.tasks.createTask(owner, f.input, { operationId: randomUUID() });
  assert.equal(f.saved()[0].length, before[0].length + 1);
  const events = f.db.prepare('SELECT * FROM task_events WHERE source_task_id=?').all(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].hook_id, 'TaskCreated');
  assert.equal(events[0].state, 'NO_BINDING');
  assert.equal(events[0].created_at, task.createdAt);
  assert.deepEqual(f.saved()[2], before[2]);

  f.db.exec("CREATE TEMP TRIGGER fail_created BEFORE INSERT ON task_events WHEN NEW.hook_id='TaskCreated' BEGIN SELECT RAISE(ABORT,'event blocked'); END");
  const after = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { operationId: randomUUID() }), /event blocked/);
  assert.deepEqual(f.saved(), after);
});

test('an allowed active rule creates one task with its normal event', async t => {
  const f = fixture(t);
  f.select();
  const before = f.saved();
  const task = await f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() });
  assert.equal(f.tasks.getTask(owner, task.id).title, f.input.title);
  assert.equal(f.saved()[0].length, before[0].length + 1);
  assert.equal(f.saved()[1].length, before[1].length + 1);
  assert.deepEqual(f.saved()[2], before[2]);
});

test('a human caller cannot supply the evaluator request key', async t => {
  const f = fixture(t);
  f.select();
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, {
    ...f.context, operationId: randomUUID(), requestKey: { type: 'demo.TaskCreateKey/1', value: randomUUID() },
  }), { status: 400 });
  assert.deepEqual(f.saved(), before);
});

for (const [name, message, expected] of [
  ['plain text', '  <b>Choose a due date</b>  ', '<b>Choose a due date</b>'],
  ['blank message', '   ', 'This task does not meet the rule. Your entries are kept.'],
  ['oversize message', 'x'.repeat(257), 'This task does not meet the rule. Your entries are kept.'],
  ['invalid Unicode', '\ud800', 'This task does not meet the rule. Your entries are kept.'],
]) test('denied creation returns ' + name + ' without saving a task or event', async t => {
  const f = fixture(t, { commitReserveMs: 20, check: async () => ({ status: 'DENIED', message }), current: () => true });
  f.select();
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() }),
    { status: 422, code: 'RULE_DENIED', message: expected });
  assert.deepEqual(f.saved(), before);
});

for (const [name, guard] of [
  ['missing evaluator', undefined],
  ['missing current authority', { commitReserveMs: 20, check: async () => allowed() }],
  ['invalid decision', { commitReserveMs: 20, check: async () => ({ status: 'SUCCESS' }), current: () => true }],
  ['missing decision', { commitReserveMs: 20, check: async () => null, current: () => true }],
  ['evaluator failure', { commitReserveMs: 20, check: async () => { throw Error('private evaluator detail'); }, current: () => true }],
  ['stale authority', { commitReserveMs: 20, check: async () => allowed(), current: () => false }],
  ['authority failure', { commitReserveMs: 20, check: async () => allowed(), current: () => { throw Error('private authority detail'); } }],
]) test(name + ' blocks creation without persisting native effects', async t => {
  const f = fixture(t, guard ?? {});
  f.select();
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() }), { status: 503, code: 'CHECK_UNAVAILABLE' });
  assert.deepEqual(f.saved(), before);
});

test('authority lost after insertion rolls the task and creation event back together', async t => {
  let current = true;
  const f = fixture(t, { commitReserveMs: 20, check: async () => allowed(), current: () => current });
  f.select();
  f.db.function('lose_create_authority', () => { current = false; });
  f.db.exec('CREATE TEMP TRIGGER lose_authority AFTER INSERT ON tasks BEGIN SELECT lose_create_authority(); END');
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() }), { status: 503, code: 'CHECK_UNAVAILABLE' });
  assert.deepEqual(f.saved(), before);
});

for (const condition of ['expired', 'cancelled', 'insufficient budget']) test(condition + ' creation has no native effects', async t => {
  const f = fixture(t);
  f.select();
  if (condition === 'expired') f.context.deadline.expiresAtMs = 0;
  if (condition === 'cancelled') f.context.signal = AbortSignal.abort();
  if (condition === 'insufficient budget') f.context.deadline.expiresAtMs = 20;
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() }),
    condition === 'insufficient budget' ? { status: 503, code: 'CHECK_UNAVAILABLE' } : { status: 409, code: 'STALE_ATTEMPT' });
  assert.deepEqual(f.saved(), before);
});

test('cancellation while checking blocks a late allow from creating anything', async t => {
  const entered = Promise.withResolvers(), result = Promise.withResolvers();
  const f = fixture(t, { commitReserveMs: 20, check: async ({ signal }) => {
    assert.equal(signal, controller.signal);
    entered.resolve();
    return result.promise;
  }, current: () => true });
  f.select();
  const controller = new AbortController(), before = f.saved();
  const creating = f.tasks.createTask(owner, f.input, { ...f.context, signal: controller.signal, operationId: randomUUID() });
  await entered.promise;
  controller.abort();
  await assert.rejects(creating, { status: 409, code: 'STALE_ATTEMPT' });
  result.resolve(allowed());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.saved(), before);
});

test('evaluation timeout blocks a later allow without a deferred write', async t => {
  const result = Promise.withResolvers();
  const f = fixture(t, { commitReserveMs: 20, check: () => result.promise, current: () => true });
  f.select();
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input,
    { deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 30 }, operationId: randomUUID() }), { status: 503, code: 'CHECK_UNAVAILABLE' });
  result.resolve(allowed());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.saved(), before);
});

test('allow delivered after the child deadline cannot spend the commit reserve', async t => {
  let now = 0;
  const f = fixture(t, { commitReserveMs: 20, check: async ({ deadline }) => {
    now = deadline.expiresAtMs;
    return allowed();
  }, current: () => true });
  f.select();
  f.context.deadline.clock.nowMs = () => now;
  const before = f.saved();
  await assert.rejects(() => f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() }), { status: 503, code: 'CHECK_UNAVAILABLE' });
  assert.deepEqual(f.saved(), before);
});

test('a rule activated after unbound preparation blocks the pending create', async t => {
  const f = fixture(t);
  const before = f.saved();
  const creating = f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() });
  f.select();
  await assert.rejects(creating, { status: 409, code: 'STALE_ATTEMPT' });
  assert.deepEqual(f.saved(), before);
});

test('changing the active selection generation during evaluation blocks the pending create', async t => {
  const entered = Promise.withResolvers(), result = Promise.withResolvers();
  const f = fixture(t, { commitReserveMs: 20, check: () => { entered.resolve(); return result.promise; }, current: () => true });
  f.select();
  const before = f.saved(), creating = f.tasks.createTask(owner, f.input, { ...f.context, operationId: randomUUID() });
  await entered.promise;
  f.db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id=? AND hook_id='TaskBeforeCreate'").run(owner);
  result.resolve(allowed());
  await assert.rejects(creating, { status: 409, code: 'STALE_ATTEMPT' });
  assert.deepEqual(f.saved(), before);
});

test('the evaluator gets a frozen normalized projection and input edits cannot change the saved proposal', async t => {
  const entered = Promise.withResolvers(), result = Promise.withResolvers();
  let observed;
  const f = fixture(t, { commitReserveMs: 20, check: args => { observed = args; entered.resolve(); return result.promise; }, current: () => true });
  const revisionId = f.select(), dueAt = '2026-03-06T16:00:00.417Z';
  Object.assign(f.input, { title: '  Original title  ', notes: '  Notes kept  ', tags: [' CAFE\u0301 ', 'café', 'Review'], priority: 'high', dueAt });
  const operationId = randomUUID();
  const creating = f.tasks.createTask(owner, f.input, { ...f.context, operationId });
  await entered.promise;
  assert.equal(observed.owner, owner);
  assert.equal(observed.requestKey.value, operationId);
  assert.equal(Object.isFrozen(observed.requestKey), true);
  assert.equal(observed.selection.revision_id, revisionId);
  assert.equal(observed.deadline.expiresAtMs, 980);
  assert.equal(Object.isFrozen(observed.selection), true);
  assert.equal(Object.isFrozen(observed.input), true);
  assert.equal(Object.isFrozen(observed.input.tags), true);
  assert.deepEqual(observed.input, { projectId: f.input.projectId, priority: 'high', tags: ['café', 'review'], hasNotes: true, hasDueDate: true });
  assert.throws(() => observed.input.tags.push('injected'), TypeError);
  Object.assign(f.input, { title: 'Newer title', notes: '', priority: 'low', dueAt: null });
  f.input.tags.push('later');
  result.resolve(allowed());
  const task = await creating;
  assert.equal(task.title, 'Original title');
  assert.equal(task.notes, '  Notes kept  ');
  assert.deepEqual(task.tags, ['café', 'review']);
  assert.equal(task.priority, 'high');
  assert.equal(task.dueAt, dueAt);
});

test('guarded native creation retains long text and the native eight-tag boundary', async t => {
  const f = fixture(t);
  f.select();
  const input = { ...f.input, title: '界'.repeat(120), notes: '界'.repeat(4000), tags: Array.from({ length: 8 }, (_, i) => String(i) + '界'.repeat(31)) };
  const task = await f.tasks.createTask(owner, input, { ...f.context, operationId: randomUUID() });
  assert.equal(task.title, input.title);
  assert.equal(task.notes, input.notes);
  assert.deepEqual(task.tags, input.tags);
  const before = f.saved();
  for (const invalid of [{ title: input.title + 'x' }, { notes: input.notes + 'x' }, { tags: [...input.tags, 'ninth'] }, { tags: ['x'.repeat(33)] }]) {
    await assert.rejects(() => f.tasks.createTask(owner, { ...input, ...invalid }, { ...f.context, operationId: randomUUID() }), { status: 400 });
    assert.deepEqual(f.saved(), before);
  }
});
