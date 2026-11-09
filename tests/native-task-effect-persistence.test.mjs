import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService, taskEffectService, revokeTaskAdmissions, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { nativeEffectService, seedTaskEffectBinding, invocationFor } from './fixtures/task-effect-schema.mjs';

const owner = 'maya';
function setup(t) {
  const db = openData(':memory:'); t.after(() => db.close());
  const tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const binding = seedTaskEffectBinding(db, owner), pins = binding.pins;
  const revision = { id: binding.revisionId, extension_id: binding.extensionId };
  const selected = () => db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(revision.id, JSON.stringify(pins), owner);
  selected();
  const effects = nativeEffectService(db);
  const complete = async () => {
    const task = await tasks.createTask(owner, { projectId, title: 'Source task' }, { operationId: randomUUID() });
    tasks.completeTask(owner, task.id);
    return effects.status(owner, db.prepare('SELECT event_id FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(task.id).event_id);
  };
  const counts = () => [db.prepare('SELECT count(*) n FROM tasks').get().n, db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n];
  return { db, tasks, projectId, revision, selected, pins, effects, complete, counts };
}
const code = (expected, action) => assert.throws(action, error => error.code === expected);
const codeAsync = (expected, action) => assert.rejects(action, error => error.code === expected);

test('native completion snapshots one owner/hook/key and preserves first result without replaying old tasks', async t => {
  const f = setup(t), e = await f.complete();
  assert.equal(e.state, 'PENDING'); assert.equal(e.owner, owner); assert.deepEqual(e.pins, f.pins);
  const original = f.tasks.getTask(owner, e.sourceTaskId);
  assert.deepEqual(e.input, { taskId: e.sourceTaskId, occurredAt: original.completedAt }); assert.notEqual(e.eventId, e.originalKey);
  assert.deepEqual(f.tasks.completeTask(owner, original.id), original);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_events WHERE hook_id=\'TaskCompleted\'').get().n, 1);
  const legacy = f.tasks.listTasks(owner, f.projectId).find(task => task.status === 'completed' && task.id !== original.id);
  f.tasks.completeTask(owner, legacy.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_events WHERE hook_id=\'TaskCompleted\'').get().n, 1);
  f.tasks.editTask(owner, original.id, { title: 'Edited', notes: '' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_events WHERE hook_id=\'TaskCompleted\'').get().n, 1);
  transaction(f.db, () => revokeTaskAdmissions(f.db, owner, f.revision.extension_id));
  const unselected = await f.complete(); assert.equal(unselected.state, 'NO_BINDING');
  assert.equal(f.effects.claim(owner, unselected.eventId), null);
});

test('event failure rolls completion back, while postcommit reaction failure leaves native success', async t => {
  const f = setup(t), task = await f.tasks.createTask(owner, { projectId: f.projectId, title: 'Atomic source' }, { operationId: randomUUID() });
  f.db.exec("CREATE TEMP TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'event blocked'); END");
  assert.throws(() => f.tasks.completeTask(owner, task.id), /event blocked/);
  assert.equal(f.tasks.getTask(owner, task.id).status, 'open');
  f.db.exec('DROP TRIGGER fail_event');
  const completed = f.tasks.completeTask(owner, task.id);
  const eventId = f.db.prepare('SELECT event_id FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(task.id).event_id;
  f.db.prepare('DELETE FROM extension_approvals WHERE owner_id=? AND revision_id=?').run(owner, f.revision.id);
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, eventId));
  assert.deepEqual(f.tasks.getTask(owner, task.id), completed);
  assert.notEqual(f.effects.status(owner, eventId).revokedAt, null);
});

test('human creation records its own unbound trigger atomically and cannot backfill after selection', async t => {
  const f = setup(t);
  const countTasks = () => f.db.prepare('SELECT count(*) n FROM tasks').get().n;
  const before = countTasks();
  f.db.exec("CREATE TEMP TRIGGER fail_creation BEFORE INSERT ON task_events WHEN NEW.hook_id='TaskCreated' BEGIN SELECT RAISE(ABORT,'creation event blocked'); END");
  const input = { projectId: f.projectId, title: 'Human creation' };
  await assert.rejects(() => f.tasks.createTask(owner, input, { operationId: randomUUID() }), /creation event blocked/);
  assert.equal(countTasks(), before);
  f.db.exec('DROP TRIGGER fail_creation');
  const task = await f.tasks.createTask(owner, input, { operationId: randomUUID() });
  const events = () => f.db.prepare('SELECT * FROM task_events WHERE source_task_id=? ORDER BY rowid').all(task.id);
  const [created] = events();
  assert.equal(created.hook_id, 'TaskCreated');
  assert.equal(created.state, 'NO_BINDING');
  assert.equal(created.created_at, task.createdAt);
  assert.equal(created.selection_generation, 0);
  assert.equal(created.revision_id, null);
  f.db.prepare("UPDATE extension_selections SET generation=8 WHERE owner_id=? AND hook_id='TaskCreated'").run(owner);
  const completed = f.tasks.completeTask(owner, task.id);
  const [retained, completion] = events();
  assert.deepEqual(retained, created);
  assert.equal(completion.hook_id, 'TaskCompleted');
  assert.equal(completion.created_at, completed.completedAt);
  assert.equal(completion.state, 'PENDING');
  assert.equal(completion.selection_generation, 1);
  assert.notEqual(completion.original_key, created.original_key);
  assert.equal(f.effects.claim(owner, created.event_id), null);
  f.tasks.completeTask(owner, task.id);
  assert.equal(events().length, 2);
});

test('a receipt for another capability blocks reuse of the same native key before mutation', async t => {
  const f = setup(t), event = await f.complete();
  assert.ok(f.effects.claim(owner, event.eventId));
  const payload = { projectId: f.projectId, title: 'Cross-action key' };
  f.db.prepare('INSERT INTO task_effect_receipts(owner_id,capability_id,original_key,capability_version,payload,result,effect) VALUES (?,?,?,?,?,?,?)').run(owner, 'tasks.update', event.originalKey, '1',
    Buffer.from(JSON.stringify(payload)), '{"kind":"BUSINESS_REJECTION","code":"TASK_INVALID","effect":"NONE"}', 'NONE');
  const before = f.counts();
  assert.deepEqual(await f.effects.createTaskOnce(owner, f.effects.keyFor(owner, event.eventId), payload),
    { kind: 'BUSINESS_REJECTION', code: 'KEY_PAYLOAD_MISMATCH', effect: 'NONE' });
  assert.deepEqual(f.counts(), before);
  assert.equal(f.effects.status(owner, event.eventId).receipt.code, 'TASK_INVALID');
});

test('same native key preserves canonical payload, immutable receipt and audit after finish/revocation', async t => {
  const f = setup(t), e = await f.complete(), key = f.effects.keyFor(owner, e.eventId);
  assert.equal(key.value, e.originalKey); assert.equal(Object.isFrozen(key), true);
  const claimed = f.effects.claim(owner, e.eventId);
  assert.equal(Object.isFrozen(claimed.pins.modelRef), true);
  assert.equal(f.effects.claim(owner, e.eventId), null);
  const request = { projectId: f.projectId, title: '  New task  ' }, before = f.counts();
  const result = await f.effects.createTaskOnce(owner, key, request);
  assert.deepEqual(result, { kind: 'SUCCESS', value: { id: result.value.id }, effect: 'CONFIRMED' });
  const created = f.tasks.getTask(owner, result.value.id);
  assert.equal(created.title, 'New task'); assert.equal(created.notes, ''); assert.equal(created.status, 'open');
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  assert.deepEqual(await f.effects.createTaskOnce(owner, key, request), result);
  assert.equal((await f.effects.createTaskOnce(owner, key, { ...request, title: 'New task' })).code, 'KEY_PAYLOAD_MISMATCH');
  assert.equal((await f.effects.createTaskOnce(owner, key, { ...request, title: 'Different' })).code, 'KEY_PAYLOAD_MISMATCH');
  f.tasks.editTask(owner, result.value.id, { title: 'Changed after creation', notes: 'Native edit' });
  const outcome = { classification: 'FAILED', effects: [{ effect: 'CONFIRMED' }], error: { code: 'OUTPUT_INVALID' } };
  assert.equal(f.effects.finish(owner, e.eventId, outcome), true);
  assert.equal(f.effects.finish(owner, e.eventId, outcome), false);
  code('OUTCOME_IMMUTABLE', () => f.effects.finish(owner, e.eventId, { classification: 'COMPLETED' }));
  transaction(f.db, () => revokeTaskAdmissions(f.db, owner, f.revision.extension_id));
  assert.deepEqual(await f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), request), result);
  const observed = f.effects.reconcile(owner, e.eventId);
  assert.deepEqual(observed.receipt, result); assert.ok(observed.observedAt);
  assert.deepEqual(f.effects.status(owner, e.eventId).outcome, outcome);
  assert.deepEqual(f.counts(), before.map(n => n + 1));
  assert.throws(() => f.effects.status('leo', e.eventId), { status: 404 });
  await codeAsync('HOST_KEY_INVALID', () => f.effects.createTaskOnce('leo', key, request));
});

test('original owner/key and STARTED are required before first write or disclosure', async t => {
  const f = setup(t), e = await f.complete(), key = f.effects.keyFor(owner, e.eventId), args = { projectId: f.projectId, title: 'Bound' };
  const before = f.counts();
  await codeAsync('EVENT_NOT_STARTED', () => f.effects.createTaskOnce(owner, key, args));
  await codeAsync('HOST_KEY_INVALID', () => f.effects.createTaskOnce(owner, { ...key }, args));
  await codeAsync('HOST_KEY_INVALID', () => f.effects.createTaskOnce('leo', key, args));
  assert.throws(() => f.effects.keyFor('leo', e.eventId), { status: 404 });
  await assert.rejects(() => f.tasks.createTask(owner, { ...args, operationKey: e.originalKey }, { operationId: randomUUID() }), { status: 400 });
  await assert.rejects(() => f.tasks.createTask(owner, { ...args, ownerId: 'leo' }, { operationId: randomUUID() }), { status: 400 });
  f.effects.claim(owner, e.eventId);
  f.effects.finish(owner, e.eventId, { classification: 'UNCERTAIN', effects: [] });
  await codeAsync('EVENT_NOT_STARTED', () => f.effects.createTaskOnce(owner, key, args));
  assert.deepEqual(f.counts(), before);
  assert.equal(f.effects.reconcile(owner, e.eventId).receipt, null, 'No receipt is not manufactured NONE');
});

test('missing and foreign projects have durable no-effect rejection without hidden retry', async t => {
  const f = setup(t), e = await f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), args = { projectId: f.tasks.listProjects('leo')[0].id, title: 'No access' }, before = f.counts();
  const result = await f.effects.createTaskOnce(owner, key, args);
  assert.deepEqual(result, { kind: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND', effect: 'NONE' });
  assert.deepEqual(await f.effects.createTaskOnce(owner, key, args), result);
  assert.equal((await f.effects.createTaskOnce(owner, key, { ...args, projectId: f.projectId })).code, 'KEY_PAYLOAD_MISMATCH');
  assert.deepEqual(f.counts(), [before[0], before[1] + 1]);
});

test('receipt insertion failure rolls native creation back and leaves no terminal fake receipt', async t => {
  const f = setup(t), e = await f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), before = f.counts();
  f.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON task_effect_receipts BEGIN SELECT RAISE(ABORT,'receipt blocked'); END");
  await assert.rejects(() => f.effects.createTaskOnce(owner, key, { projectId: f.projectId, title: 'Atomic effect' }), /receipt blocked/);
  assert.deepEqual(f.counts(), before); assert.equal(f.effects.status(owner, e.eventId).receipt, null);
});

for (const field of ['approval', 'revocation']) test(`current ${field} denial at native commit rolls back task/receipt but permanently records revocation`, async t => {
  const f = setup(t), e = await f.complete();
  f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), before = f.counts();
  f.db.exec(`CREATE TEMP TRIGGER revoke_after_receipt AFTER INSERT ON task_effect_receipts BEGIN ${field === 'approval'
    ? 'DELETE FROM extension_approvals;'
    : 'UPDATE task_events SET revoked_at=1 WHERE original_key=NEW.original_key;'} END`);
  await codeAsync('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, key, { projectId: f.projectId, title: 'Must roll back' }));
  assert.deepEqual(f.counts(), before);
  assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
  const fresh = nativeEffectService(f.db);
  await codeAsync('AUTHORITY_DENIED', () => fresh.createTaskOnce(owner, fresh.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Still denied' }));
  assert.deepEqual(f.counts(), before);
});

for (const [name, mutation] of [
  ['calls', "json_set(payload,'$.reports[0].report.calls',json('[]'))"],
  ['report count', "json_set(payload,'$.reports',json('[]'))"],
  ['expectations', "json_set(payload,'$.reports[0].expected.calls',json('[]'))"],
  ['native outcome', "json_set(payload,'$.reports[0].report.native.result.status','NO_OP')"],
  ['consumption', "json_set(payload,'$.reports[0].report.consumption',json('{}'))"],
  ['string mismatches', "json_set(payload,'$.reports[0].report.mismatches','')"],
  ['object mismatches', "json_set(payload,'$.reports[0].report.mismatches',json('{\"length\":0}'))"],
  ['suite identity', "json_set(payload,'$.identity.suiteDigest','self-matching-but-not-the-saved-suite')"],
]) test(`captured proof ${name} mutation at native commit rolls back and durably revokes`, async t => {
  const f = setup(t), e = await f.complete();
  f.effects.claim(owner, e.eventId);
  const before = f.counts(), proof = f.db.prepare('SELECT * FROM extension_evidence WHERE id=?').get(e.pins.approvedEvidenceId);
  f.db.exec(`CREATE TEMP TRIGGER mutate_proof_at_commit AFTER INSERT ON task_effect_receipts BEGIN
    UPDATE extension_evidence SET payload=${mutation}${name === 'suite identity' ? ",suite_identity='self-matching-but-not-the-saved-suite'" : ''}
      WHERE id='${e.pins.approvedEvidenceId}'; END`);
  await codeAsync('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Must roll back with altered proof' }));
  assert.deepEqual(f.counts(), before); assert.equal(f.effects.status(owner, e.eventId).receipt, null);
  assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
  assert.deepEqual(f.db.prepare('SELECT * FROM extension_evidence WHERE id=?').get(e.pins.approvedEvidenceId), proof, 'Savepoint rolls back the mutated proof with the task/receipt');
  f.db.exec('DROP TRIGGER mutate_proof_at_commit');
  await codeAsync('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Still revoked after proof restoration' }));
  assert.deepEqual(f.counts(), before);
});

test('missing, malformed or expired direct deadline fails closed and records observed revocation', async t => {
  assert.throws(() => taskEffectService({}), TypeError);
  const missing = setup(t), pending = await missing.complete();
  assert.throws(() => taskEffectService(missing.db, { authorizeWrite: () => true }), TypeError);
  code('AUTHORITY_DENIED', () => taskEffectService(missing.db).claim(owner, pending.eventId));
  assert.notEqual(missing.effects.status(owner, pending.eventId).revokedAt, null);
  for (const nowMs of [() => 1000, () => NaN, () => -1, () => undefined, () => { throw Error('Denied'); }, async () => 0]) {
    const f = setup(t), e = await f.complete(), service = taskEffectService(f.db);
    const invocation = invocationFor(service, owner, e.eventId); invocation.deadline.clock.nowMs = nowMs;
    code('AUTHORITY_DENIED', () => service.claim(owner, e.eventId, invocation));
    assert.notEqual(f.effects.status(owner, e.eventId).revokedAt, null);
    assert.equal(f.effects.status(owner, e.eventId).receipt, null);
  }
});

test('direct native context requires original key, owner and exact event/source on every call', async t => {
  const f = setup(t), event = await f.complete(), service = taskEffectService(f.db), context = invocationFor(service, owner, event.eventId);
  assert.equal(service.contextFor(owner, context).eventId, event.eventId);
  for (const changed of [{ ...context, requestKey: { ...context.requestKey } },
    { ...context, event: { ...context.event, id: 'other-event' } }, { ...context, event: { ...context.event, source: 'other-task' } }])
    assert.throws(() => service.contextFor(owner, changed), error => ['HOST_KEY_INVALID', 'HOST_CONTEXT_INVALID'].includes(error.code));
  code('HOST_KEY_INVALID', () => service.contextFor('leo', context));
  assert.equal(f.effects.status(owner, event.eventId).state, 'PENDING');
  assert.equal(f.effects.status(owner, event.eventId).receipt, null);
});

test('fresh native authority detects replaced captured proof and altered source, artifact or suite bytes', async t => {
  for (const mutation of [
    "UPDATE extension_authored SET source=x'74616d7065726564'",
    "UPDATE extension_authored SET artifact=x'7b7d'",
    "UPDATE extension_authored SET suite='[\"tampered\"]'",
    "UPDATE extension_evidence SET identity='{}'",
    "UPDATE extension_evidence SET payload='{}'",
    'UPDATE extension_evidence SET passed=0',
    'DELETE FROM extension_approvals',
  ]) {
    const f = setup(t), event = await f.complete(), before = f.counts();
    f.db.exec(mutation);
    code('AUTHORITY_DENIED', () => f.effects.claim(owner, event.eventId));
    assert.deepEqual(f.counts(), before);
    assert.notEqual(f.effects.status(owner, event.eventId).revokedAt, null);
  }
});

test('replacement preserves old admission; explicit disable/re-enable does not resurrect it', async t => {
  const f = setup(t), e = await f.complete(), legacy = createLifecycle(f.db);
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
  await codeAsync('AUTHORITY_DENIED', () => f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Old denied' }));
  const next = await f.complete(); assert.ok(f.effects.claim(owner, next.eventId));
  assert.deepEqual(f.effects.status(owner, e.eventId).pins, f.pins);
});

test('deleting an unselected replaced item revokes all its old admissions, preserves effects and prevents future binding', async t => {
  const f = setup(t), first = await f.complete(), second = await f.complete();
  f.effects.claim(owner, first.eventId);
  const committed = await f.effects.createTaskOnce(owner, f.effects.keyFor(owner, first.eventId), { projectId: f.projectId, title: 'Keep this real task' });
  f.effects.finish(owner, first.eventId, { classification: 'COMPLETED', effects: [{ effect: 'CONFIRMED' }] });
  f.db.prepare("UPDATE extension_selections SET revision_id=NULL,binding_pins=NULL,generation=generation+1 WHERE owner_id=? AND hook_id='TaskCompleted'").run(owner);
  const lifecycle = createLifecycle(f.db), state = lifecycle.state(owner, f.revision.extension_id);
  lifecycle.delete(owner, { extensionId: f.revision.extension_id, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation }, () => {});
  assert.notEqual(f.effects.status(owner, second.eventId).revokedAt, null);
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, second.eventId));
  assert.deepEqual(f.effects.status(owner, first.eventId).receipt, committed);
  assert.equal(f.tasks.getTask(owner, committed.value.id).title, 'Keep this real task');
  assert.equal((await f.complete()).state, 'NO_BINDING');
});

test('originating owner is independent of browser user and generated task completion is a distinct occurrence', async t => {
  let browserOwner = owner;
  const f = setup(t);
  const e = await f.complete(); browserOwner = 'leo';
  assert.equal(browserOwner, 'leo'); assert.equal(f.effects.claim(owner, e.eventId).owner, owner);
  const created = await f.effects.createTaskOnce(owner, f.effects.keyFor(owner, e.eventId), { projectId: f.projectId, title: 'Generated' });
  assert.throws(() => f.tasks.getTask(browserOwner, created.value.id), { status: 404 });
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_events WHERE source_task_id=?').get(created.value.id).n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_events WHERE hook_id=\'TaskCompleted\'').get().n, 1);
  f.tasks.completeTask(owner, created.value.id);
  const next = f.db.prepare('SELECT * FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(created.value.id);
  assert.ok(next); assert.notEqual(next.event_id, e.eventId); assert.notEqual(next.original_key, e.originalKey);
  assert.ok(f.effects.claim(owner, next.event_id));
});

test('keyed validation rejects malformed Unicode before canonicalization, preserving native title semantics and raw project identity', async t => {
  const f = setup(t), e = await f.complete(); f.effects.claim(owner, e.eventId);
  const key = f.effects.keyFor(owner, e.eventId), base = { projectId: f.projectId, title: 'Valid' }, before = f.counts();
  for (const bad of [{ title: '\ud800' }, { title: '\udc00' }, { projectId: '\ud800' }, { title: null }, { projectId: 3 }, { title: '😀'.repeat(65) }])
    await assert.rejects(() => f.effects.createTaskOnce(owner, key, { ...base, ...bad }), { status: 400 });
  assert.deepEqual(f.counts(), before);
  const title = '😀'.repeat(60), result = await f.effects.createTaskOnce(owner, key, { ...base, title: ` ${title} ` });
  assert.equal(f.tasks.getTask(owner, result.value.id).title, title);
  assert.deepEqual(await f.effects.createTaskOnce(owner, key, { ...base, title: ` ${title} ` }), result);
  assert.equal((await f.effects.createTaskOnce(owner, key, { ...base, title })).code, 'KEY_PAYLOAD_MISMATCH');
  assert.equal((await f.effects.createTaskOnce(owner, key, { ...base, title, projectId: ` ${base.projectId} ` })).code, 'KEY_PAYLOAD_MISMATCH');
  const ordinary = await f.tasks.createTask(owner, { ...base, title: '\ud800' }, { operationId: randomUUID() });
  assert.equal(ordinary.title, '\ufffd', 'Existing ordinary CRUD behavior remains unchanged');
});

test('invalid pinned dependencies fail reaction admission after native completion, without borrowing read selection', async t => {
  const f = setup(t);
  f.db.prepare("UPDATE extension_selections SET binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'").run('{"profile":"keir-read/2"}', owner);
  const e = await f.complete();
  code('AUTHORITY_DENIED', () => f.effects.claim(owner, e.eventId));
  assert.equal(f.tasks.getTask(owner, e.sourceTaskId).status, 'completed');
  assert.equal(f.effects.status(owner, e.eventId).receipt, null);
});
