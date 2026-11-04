import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService, taskEffectService, revokeTaskAdmissions, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';

const owner = 'maya';
const pins = {
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  modelRef: { domainId: 'demo.tasks', domainVersion: '2', format: 'keir-dcm/effect-3', digest: `sha256:${'b'.repeat(64)}`, descriptorRecipe: 'keir-record-descriptors/1' },
  compiler: { id: 'fixture', version: '1' }, environment: { id: 'fixture', version: '1' },
  consumer: { id: 'demo.task-effects', version: '1', kind: 'EVENT_REPORT' },
  qualification: { id: 'fixture-report', revision: 1, reportDigest: `sha256:${'c'.repeat(64)}`, hostBuild: `sha256:${'d'.repeat(64)}` },
};
function setup(t, overrides = {}) {
  const db = openData(':memory:'); t.after(() => db.close());
  const tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const revision = db.prepare('SELECT r.id,l.extension_id FROM extension_revisions r JOIN extension_revision_links l ON l.revision_id=r.id WHERE r.owner_id=?').get(owner);
  const selected = () => db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(revision.id, JSON.stringify(pins), owner);
  selected();
  const flags = { read: true, write: true, qualification: true };
  const effects = taskEffectService(db, { authorizeRead: () => flags.read, authorizeWrite: () => flags.write,
    isQualificationCurrent: () => flags.qualification, ...overrides });
  const complete = () => {
    const task = tasks.createTask(owner, { projectId, title: 'Source task' });
    tasks.completeTask(owner, task.id);
    return effects.status(owner, db.prepare('SELECT event_id FROM task_completion_events WHERE source_task_id=?').get(task.id).event_id);
  };
  const counts = () => [db.prepare('SELECT count(*) n FROM tasks').get().n, db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n];
  return { db, tasks, projectId, revision, selected, flags, effects, complete, counts };
}
const code = (expected, action) => assert.throws(action, error => error.code === expected);

test('native completion snapshots one owner/hook/key and preserves first result without replaying old tasks', t => {
  const f = setup(t), e = f.complete();
  assert.equal(e.state, 'PENDING'); assert.equal(e.owner, owner); assert.deepEqual(e.pins, pins);
  assert.deepEqual(e.input, { taskId: e.sourceTaskId }); assert.notEqual(e.eventId, e.originalKey);
  const original = f.tasks.getTask(owner, e.sourceTaskId);
  assert.deepEqual(f.tasks.completeTask(owner, original.id), original);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_completion_events').get().n, 1);
  const legacy = f.tasks.listTasks(owner, f.projectId).find(task => task.status === 'completed' && task.id !== original.id);
  f.tasks.completeTask(owner, legacy.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_completion_events').get().n, 1);
  f.tasks.editTask(owner, original.id, { title: 'Edited', notes: '' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_completion_events').get().n, 1);
  transaction(f.db, () => revokeTaskAdmissions(f.db, owner, f.revision.extension_id));
  const unselected = f.complete(); assert.equal(unselected.state, 'NO_BINDING');
  assert.equal(f.effects.claim(owner, unselected.eventId), null);
});

test('event failure rolls completion back, while postcommit reaction failure leaves native success', t => {
  const f = setup(t), task = f.tasks.createTask(owner, { projectId: f.projectId, title: 'Atomic source' });
  f.db.exec("CREATE TEMP TRIGGER fail_event BEFORE INSERT ON task_completion_events BEGIN SELECT RAISE(ABORT,'event blocked'); END");
  assert.throws(() => f.tasks.completeTask(owner, task.id), /event blocked/);
  assert.equal(f.tasks.getTask(owner, task.id).status, 'open');
  f.db.exec('DROP TRIGGER fail_event');
  const completed = f.tasks.completeTask(owner, task.id);
  const eventId = f.db.prepare('SELECT event_id FROM task_completion_events WHERE source_task_id=?').get(task.id).event_id;
  f.flags.qualification = false;
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, eventId));
  assert.deepEqual(f.tasks.getTask(owner, task.id), completed);
  assert.notEqual(f.effects.status(owner, eventId).revokedAt, null);
});

test('same native key preserves canonical payload, immutable receipt and audit after finish/revocation', t => {
  const f = setup(t), e = f.complete(), key = f.effects.keyFor(owner, e.eventId);
  assert.equal(key.value, e.originalKey); assert.equal(Object.isFrozen(key), true);
  const claimed = f.effects.claim(owner, e.eventId);
  assert.equal(Object.isFrozen(claimed.pins.qualification), true);
  assert.equal(f.effects.claim(owner, e.eventId), null);
  const request = { projectId: f.projectId, title: '  New task  ' }, before = f.counts();
  const result = f.effects.createTaskOnce(owner, key, request);
  assert.deepEqual(result, { kind: 'SUCCESS', value: { id: result.value.id }, effect: 'CONFIRMED' });
  const created = f.tasks.getTask(owner, result.value.id);
  assert.equal(created.title, 'New task'); assert.equal(created.notes, ''); assert.equal(created.status, 'open');
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  assert.deepEqual(f.effects.createTaskOnce(owner, key, { ...request, title: 'New task' }), result);
  assert.equal(f.effects.createTaskOnce(owner, key, { ...request, title: 'Different' }).code, 'KEY_PAYLOAD_MISMATCH');
  f.tasks.editTask(owner, result.value.id, { title: 'Changed after creation', notes: 'Native edit' });
  const outcome = { classification: 'FAILED', effects: [{ effect: 'CONFIRMED' }], error: { code: 'OUTPUT_INVALID' } };
  assert.equal(f.effects.finish(owner, e.eventId, outcome), true);
  assert.equal(f.effects.finish(owner, e.eventId, outcome), false);
  code('OUTCOME_IMMUTABLE', () => f.effects.finish(owner, e.eventId, { classification: 'COMPLETED' }));
  f.flags.write = false; f.flags.qualification = false;
  transaction(f.db, () => revokeTaskAdmissions(f.db, owner, f.revision.extension_id));
  assert.deepEqual(f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), request), result);
  const observed = f.effects.reconcile(owner, e.eventId);
  assert.deepEqual(observed.receipt, result); assert.ok(observed.observedAt);
  assert.deepEqual(f.effects.status(owner, e.eventId).outcome, outcome);
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  f.flags.read = false;
  code('AUTHORITY_DENIED', () => f.effects.status(owner, e.eventId));
  code('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, key, request));
});

test('original owner/key and STARTED are required before first write or disclosure', t => {
  const f = setup(t), e = f.complete(), key = f.effects.keyFor(owner, e.eventId), args = { projectId: f.projectId, title: 'Bound' };
  const before = f.counts();
  code('EVENT_NOT_STARTED', () => f.effects.createTaskOnce(owner, key, args));
  code('HOST_KEY_INVALID', () => f.effects.createTaskOnce(owner, { ...key }, args));
  code('HOST_KEY_INVALID', () => f.effects.createTaskOnce('leo', key, args));
  assert.throws(() => f.effects.keyFor('leo', e.eventId), { status: 404 });
  assert.throws(() => f.tasks.createTask(owner, { ...args, operationKey: e.originalKey }), { status: 400 });
  assert.throws(() => f.tasks.createTask(owner, { ...args, ownerId: 'leo' }), { status: 400 });
  f.effects.claim(owner, e.eventId);
  f.effects.finish(owner, e.eventId, { classification: 'UNCERTAIN', effects: [] });
  code('EVENT_NOT_STARTED', () => f.effects.createTaskOnce(owner, key, args));
  assert.deepEqual(f.counts(), before);
  assert.equal(f.effects.reconcile(owner, e.eventId).receipt, null, 'No receipt is not manufactured NONE');
});

test('missing and foreign projects have durable no-effect rejection without hidden retry', t => {
  const f = setup(t), e = f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), args = { projectId: f.tasks.listProjects('leo')[0].id, title: 'No access' }, before = f.counts();
  const result = f.effects.createTaskOnce(owner, key, args);
  assert.deepEqual(result, { kind: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND', effect: 'NONE' });
  assert.deepEqual(f.effects.createTaskOnce(owner, key, args), result);
  assert.equal(f.effects.createTaskOnce(owner, key, { ...args, projectId: f.projectId }).code, 'KEY_PAYLOAD_MISMATCH');
  assert.deepEqual(f.counts(), [before[0], before[1] + 1]);
});

test('receipt insertion failure rolls native creation back and leaves no terminal fake receipt', t => {
  const f = setup(t), e = f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), before = f.counts();
  f.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON task_effect_receipts BEGIN SELECT RAISE(ABORT,'receipt blocked'); END");
  assert.throws(() => f.effects.createTaskOnce(owner, key, { projectId: f.projectId, title: 'Atomic effect' }), /receipt blocked/);
  assert.deepEqual(f.counts(), before); assert.equal(f.effects.status(owner, e.eventId).receipt, null);
});

for (const field of ['write', 'qualification']) test(`current ${field} denial at native commit rolls back task/receipt but permanently records revocation`, t => {
  let checks = 0;
  const name = field === 'write' ? 'authorizeWrite' : 'isQualificationCurrent';
  const f = setup(t, { [name]: context => !context.projectId || ++checks === 1 }), e = f.complete();
  f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), before = f.counts();
  code('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, key, { projectId: f.projectId, title: 'Must roll back' }));
  assert.equal(checks, 2); assert.deepEqual(f.counts(), before);
  assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
  const fresh = taskEffectService(f.db, { authorizeRead: () => true, authorizeWrite: () => true, isQualificationCurrent: () => true });
  code('AUTHORITY_DENIED', () => fresh.createTaskOnce(owner, fresh.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Still denied' }));
  assert.deepEqual(f.counts(), before);
});

test('strict synchronous Boolean authority fails closed and records observed revocation', t => {
  assert.throws(() => taskEffectService({}), TypeError);
  for (const check of [() => false, () => 1, () => undefined, () => { throw Error('Denied'); }, async () => true, () => ({ then() {} })]) {
    const f = setup(t, { isQualificationCurrent: check }), e = f.complete();
    code('AUTHORITY_DENIED', () => f.effects.claim(owner, e.eventId));
    assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
    assert.equal(f.effects.status(owner, e.eventId).receipt, null);
  }
});

test('replacement preserves old admission; explicit disable/re-enable does not resurrect it', t => {
  const f = setup(t), e = f.complete(), legacy = createLifecycle(f.db);
  const revision2 = 'replacement-revision';
  f.db.prepare('INSERT INTO extension_revisions SELECT ?,owner_id,template_id,identity,provenance FROM extension_revisions WHERE id=?').run(revision2, f.revision.id);
  f.db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revision2, owner, f.revision.extension_id);
  f.db.prepare("INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,2,'operator')").run(owner, revision2);
  f.db.prepare("UPDATE extension_selections SET revision_id=?,generation=2 WHERE owner_id=? AND hook_id='TaskCompleted'").run(revision2, owner);
  assert.equal(f.effects.claim(owner, e.eventId).revisionId, f.revision.id);
  const active = legacy.state(owner, f.revision.extension_id);
  legacy.disable(owner, { extensionId: f.revision.extension_id, generation: active.selection.generation }, () => {});
  assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
  f.selected();
  code('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Old denied' }));
  const next = f.complete(); assert.ok(f.effects.claim(owner, next.eventId));
  assert.deepEqual(f.effects.status(owner, e.eventId).pins, pins);
});

test('deleting an unselected replaced item revokes all its old admissions, preserves effects and prevents future binding', t => {
  const f = setup(t), first = f.complete(), second = f.complete();
  f.effects.claim(owner, first.eventId);
  const committed = f.effects.createTaskOnce(owner, f.effects.keyFor(owner, first.eventId), { projectId: f.projectId, title: 'Keep this real task' });
  f.effects.finish(owner, first.eventId, { classification: 'COMPLETED', effects: [{ effect: 'CONFIRMED' }] });
  f.db.prepare("UPDATE extension_selections SET revision_id=NULL,generation=generation+1 WHERE owner_id=? AND hook_id='ClassifyTask'").run(owner);
  const lifecycle = createLifecycle(f.db), state = lifecycle.state(owner, f.revision.extension_id);
  lifecycle.delete(owner, { extensionId: f.revision.extension_id, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation }, () => {});
  assert.notEqual(f.effects.status(owner, second.eventId).revokedAt, null);
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, second.eventId));
  assert.deepEqual(f.effects.status(owner, first.eventId).receipt, committed);
  assert.equal(f.tasks.getTask(owner, committed.value.id).title, 'Keep this real task');
  assert.equal(f.complete().state, 'NO_BINDING');
});

test('originating owner is independent of browser user and generated task completion is a distinct occurrence', t => {
  let browserOwner = owner;
  const f = setup(t, { authorizeWrite: context => context.owner === owner });
  const e = f.complete(); browserOwner = 'leo';
  assert.equal(browserOwner, 'leo'); assert.equal(f.effects.claim(owner, e.eventId).owner, owner);
  const created = f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Generated' });
  assert.throws(() => f.tasks.getTask(browserOwner, created.value.id), { status: 404 });
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_completion_events').get().n, 1);
  f.tasks.completeTask(owner, created.value.id);
  const next = f.db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(created.value.id);
  assert.ok(next); assert.notEqual(next.event_id, e.eventId); assert.notEqual(next.original_key, e.originalKey);
  assert.ok(f.effects.claim(owner, next.event_id));
});

test('keyed validation rejects malformed Unicode before canonicalization, preserving native title semantics and raw project identity', t => {
  const f = setup(t), e = f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), base = { projectId: f.projectId, title: 'Valid' }, before = f.counts();
  for (const bad of [{ title: '\ud800' }, { title: '\udc00' }, { projectId: '\ud800' }, { title: null }, { projectId: 3 }, { title: '😀'.repeat(61) }])
    assert.throws(() => f.effects.createTaskOnce(owner, key, { ...base, ...bad }), { status: 400 });
  assert.deepEqual(f.counts(), before);
  const title = '😀'.repeat(60), result = f.effects.createTaskOnce(owner, key, { ...base, title: ` ${title} ` });
  assert.equal(f.tasks.getTask(owner, result.value.id).title, title);
  assert.deepEqual(f.effects.createTaskOnce(owner, key, { ...base, title }), result);
  assert.equal(f.effects.createTaskOnce(owner, key, { ...base, title, projectId: ` ${base.projectId} ` }).code, 'KEY_PAYLOAD_MISMATCH');
  const ordinary = f.tasks.createTask(owner, { ...base, title: '\ud800' });
  assert.equal(ordinary.title, '\ufffd', 'Existing ordinary CRUD behavior remains unchanged');
});

test('invalid pinned dependencies fail reaction admission after native completion, without borrowing read selection', t => {
  const f = setup(t);
  f.db.prepare("UPDATE extension_selections SET binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'").run('{"profile":"keir-read/2"}', owner);
  const e = f.complete();
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, e.eventId));
  assert.equal(f.tasks.getTask(owner, e.sourceTaskId).status, 'completed');
  assert.equal(f.effects.status(owner, e.eventId).receipt, null);
});
