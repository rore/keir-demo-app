import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { CheckedExprSchema } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { openData, taskService, taskEffectService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTaskCreateGuard } from '../src/task-create-guard.mjs';
import { taskRuleDescription } from '../src/task-rule-description.mjs';
import { authoringDefinition } from '../src/extension-catalog.mjs';
import { taskTagNotesFixture } from './fixtures/task-tag-notes.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { seedTaskEffectBinding, invocationFor } from './fixtures/task-effect-schema.mjs';

const owner = 'maya';
const four = ['client', 'review', 'internal', 'launch'];
const eight = [...four, 'design', 'ready', 'quote', 'followup'];
const input = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });

async function setup(t) {
  const db = openData(':memory:');
  const lifecycle = createLifecycle(db, { compiler: createCompiler() });
  const guard = createTaskCreateGuard({ db, lifecycle, commitReserveMs: 100 });
  t.after(async () => { await guard.close(); db.close(); });
  let guardChecks = 0;
  const tasks = taskService(db, { guard: { commitReserveMs: guard.commitReserveMs,
    check: context => { guardChecks++; return guard.check(context); }, current: (...args) => guard.current(...args) } });
  const projectId = tasks.listProjects(owner)[0].id;
  const fixture = taskTagNotesFixture({ projectId });
  const nativeBefore = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const selectionsBefore = db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all();
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner, name: 'Notes for tagged tasks' });
  let state = await lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', source: fixture.source, draftVersion: 0 }, () => {});
  state = await lifecycle.proposeScenarios(owner, { ...input(state), cases: fixture.cases }, () => {});
  state = await lifecycle.simulate(owner, input(state), () => {});
  assert.equal(state.evidence.passed, true);
  const proof = lifecycle.evidence(owner, state.evidence.id, extensionId);
  assert.equal(proof.reports.length, 8);
  assert.ok(proof.reports.every(row => row.report.status === 'PASS' && row.report.calls.length === 0 && row.report.native.effects.length === 0));
  assert.deepEqual(proof.reports.at(-1).report.consumption, { status: 'BLOCKED' });
  assert.equal(proof.summary.cases.at(-1).simulatedFailure, 'invalid-host-context');
  const saved = lifecycle.source(owner, state.draft.id, extensionId);
  assert.equal(saved.pins.compiler, 'keir-compiler-java/0.5.0');
  assert.equal(JSON.parse(saved.artifact).format, 'keir-artifact/4');
  assert.equal(saved.ruleDescription.coverage, 'complete');
  assert.deepEqual(saved.ruleDescription.guard.conditions, [{ field: 'tagCount', value: 3 }, { field: 'hasNotes', value: false }]);
  state = lifecycle.approve(owner, { ...input(state), evidenceId: proof.id }, () => {});
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), nativeBefore);
  assert.deepEqual(db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all(), selectionsBefore);
  state = lifecycle.activate(owner, { ...input(state), evidenceId: proof.id, generation: state.selection.generation }, () => {});
  assert.deepEqual(db.prepare("SELECT * FROM extension_selections WHERE owner_id!='maya' OR hook_id!='TaskBeforeCreate' ORDER BY owner_id,hook_id").all(),
    selectionsBefore.filter(row => row.owner_id !== owner || row.hook_id !== 'TaskBeforeCreate'));
  const counts = () => ['tasks', 'task_events', 'task_create_operations', 'task_effect_receipts'].map(table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  const create = (changes = {}, operationId = randomUUID()) => tasks.createTask(owner, { projectId, title: 'Tagged task', ...changes }, { operationId });
  return { db, lifecycle, guard, tasks, projectId, fixture, state, saved, proof, counts, create, checks: () => guardChecks };
}

test('actual numeric guard enforces normalized tag/notes boundaries and native receipts', { timeout: 60_000 }, async t => {
  const f = await setup(t);
  for (const tags of [four, eight]) for (const notes of ['', ' \t\n ']) {
    const before = f.counts(), operationId = randomUUID();
    await assert.rejects(() => f.create({ tags, notes }, operationId), error => error.code === 'RULE_DENIED'
      && error.state === 'NOT_CREATED' && error.message === f.fixture.metadata.message);
    assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1, before[3]]);
    assert.equal(f.tasks.getCreateOperation(owner, operationId).state, 'NOT_CREATED');
  }
  for (const changes of [{}, ...[1, 2, 3].map(count => ({ tags: four.slice(0, count) })),
    ...[4, 5, 6, 7, 8].map(count => ({ tags: eight.slice(0, count), notes: 'Useful context' })),
    { tags: [' Client ', 'client', 'REVIEW', 'internal'] }, { tags: [' Cafe\u0301 ', 'CAFÉ', 'review', 'internal'] }]) {
    const before = f.counts(), task = await f.create(changes);
    assert.deepEqual(f.counts(), [before[0] + 1, before[1] + 1, before[2] + 1, before[3]]);
    assert.deepEqual(f.tasks.getTask(owner, task.id), task);
    assert.equal(f.db.prepare("SELECT count(*) n FROM task_events WHERE source_task_id=? AND hook_id='TaskCreated'").get(task.id).n, 1);
    assert.throws(() => f.tasks.getTask('leo', task.id), { status: 404 });
  }
  for (const tags of [[...eight, 'ninth'], ['bad,tag'], [''], ['bad\u0000tag']]) {
    const before = f.counts(), checks = f.checks();
    await assert.rejects(() => f.create({ tags, notes: 'Cannot waive native validation' }), { status: 400 });
    assert.deepEqual(f.counts(), before);
    assert.equal(f.checks(), checks, 'Native invalid tags never reach the selected hook.');
  }
  // A lost success response is reconciled under its original ID, not a fresh creation.
  const operationId = randomUUID(), first = await f.create({ tags: four, notes: 'Saved context' }, operationId), before = f.counts();
  assert.deepEqual(f.tasks.getCreateOperation(owner, operationId), { operationId, state: 'CREATED', task: first });
  assert.deepEqual(await f.create({ tags: four, notes: 'Saved context' }, operationId), first);
  assert.deepEqual(f.counts(), before);
  // Creation-only: a later native edit is not retroactively denied.
  assert.equal(f.tasks.editTask(owner, first.id, { tags: eight, notes: '', title: first.title }).tags.length, 8);
  f.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(f.proof.id);
  await assert.rejects(() => f.create({ tags: four, notes: 'Would otherwise pass' }), { code: 'CHECK_UNAVAILABLE', state: 'NOT_CREATED' });
});

test('automation uses the actual selected numeric guard and keeps original-key NONE receipts', { timeout: 60_000 }, async t => {
  const f = await setup(t), binding = seedTaskEffectBinding(f.db, owner);
  f.db.prepare("UPDATE extension_selections SET revision_id=?,binding_pins=?,generation=generation+1 WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(binding.revisionId, JSON.stringify(binding.pins), owner);
  const effects = taskEffectService(f.db, { guard: f.guard });
  for (const tags of [four, eight]) for (const [notes, effect] of [['', 'NONE'], [' \t ', 'NONE'], ['Useful context', 'CONFIRMED']]) {
    const source = await f.create(); f.tasks.completeTask(owner, source.id);
    const eventId = f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(source.id).event_id;
    const invocation = invocationFor(effects, owner, eventId); assert.ok(effects.claim(owner, eventId, invocation));
    const args = { projectId: f.projectId, title: 'Automated tagged task', tagsText: tags.join(','), notes };
    const before = f.counts(), result = await effects.createTaskOnce(owner, invocation.requestKey, args, invocation);
    assert.equal(result.effect, effect);
    assert.deepEqual(f.counts(), [before[0] + (effect === 'CONFIRMED' ? 1 : 0), before[1], before[2], before[3] + 1]);
    const row = f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, invocation.requestKey.value);
    assert.equal(row.affected_task_id, effect === 'NONE' ? null : result.value.id);
    if (effect === 'NONE') assert.equal(JSON.parse(row.guard_details).code, 'TASK_CREATE_DENIED');
    assert.deepEqual(await effects.createTaskOnce(owner, invocation.requestKey, args, invocation), result);
    assert.deepEqual(f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, invocation.requestKey.value), row);
  }
  const source = await f.create(); f.tasks.completeTask(owner, source.id);
  const eventId = f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(source.id).event_id;
  const invocation = invocationFor(effects, owner, eventId); assert.ok(effects.claim(owner, eventId, invocation));
  f.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(f.proof.id);
  const args = { projectId: f.projectId, title: 'Unavailable required check', tagsText: four.join(','), notes: 'Would otherwise pass' };
  const before = f.counts(), result = await effects.createTaskOnce(owner, invocation.requestKey, args, invocation);
  assert.deepEqual(result, { kind: 'TRANSIENT_FAILURE', effect: 'NONE' });
  assert.deepEqual(f.counts(), [before[0], before[1], before[2], before[3] + 1]);
  const receipt = f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, invocation.requestKey.value);
  assert.equal(JSON.parse(receipt.guard_details).code, 'TASK_CREATE_UNAVAILABLE');
  assert.equal(receipt.affected_task_id, null);
  f.db.prepare('UPDATE extension_evidence SET passed=1 WHERE id=?').run(f.proof.id);
  assert.deepEqual(await effects.createTaskOnce(owner, invocation.requestKey, args, invocation), result);
  assert.deepEqual(f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, invocation.requestKey.value), receipt);
});

test('checked numeric summaries fail closed on unsupported comparisons, overloads and model recipes', { timeout: 60_000 }, async () => {
  const fixture = taskTagNotesFixture(), compiler = createCompiler();
  for (const condition of ['size(input.tags) >= 3 && !input.hasNotes', 'size(input.tags) > 3 || !input.hasNotes']) {
    const source = JSON.parse(fixture.source); source.steps[0].let.cel = condition;
    const compiled = await compiler.compile(Buffer.from(JSON.stringify(source)), { definition: fixture.host });
    assert.deepEqual(compiled.diagnostics, []);
    assert.notEqual(taskRuleDescription(JSON.parse(compiled.artifact), fixture.host).coverage, 'complete');
  }
  const compiled = await compiler.compile(Buffer.from(fixture.source), { definition: fixture.host });
  assert.deepEqual(compiled.diagnostics, []);
  for (const overload of ['size_list', 'greater_int64']) for (const replacement of [[], ['unknown_overload']]) {
    const artifact = JSON.parse(compiled.artifact); let changed = 0;
    for (const expression of Object.values(artifact.expressions)) {
      const checked = fromBinary(CheckedExprSchema, Buffer.from(expression.checked, 'base64'));
      for (const reference of Object.values(checked.referenceMap)) if (reference.overloadId.includes(overload)) {
        reference.overloadId = replacement; changed++;
      }
      expression.checked = Buffer.from(toBinary(CheckedExprSchema, checked)).toString('base64');
    }
    assert.ok(changed, 'Mutate the actual checked overload, not an unrelated expression.');
    assert.notEqual(taskRuleDescription(artifact, fixture.host).coverage, 'complete');
  }
  const artifact = JSON.parse(compiled.artifact); artifact.modelRef.descriptorRecipe = 'keir-record-descriptors/2';
  assert.notEqual(taskRuleDescription(artifact, fixture.host).coverage, 'complete');
});

test('retained authoring and numeric profiles switch both ways without approval transfer', { timeout: 60_000 }, async t => {
  const f = await setup(t), extensionId = f.state.extension.id;
  const numericId = f.state.draft.id, numericProof = f.proof.id;
  for (const modelDigest of ['sha256:' + '0'.repeat(64), null, {}]) {
    await assert.rejects(() => f.lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', source: f.fixture.source,
      modelDigest, draftVersion: f.state.draftVersion }, () => {}), { status: 400 });
    assert.equal(f.lifecycle.state(owner, extensionId).draft.id, numericId);
    assert.equal(f.lifecycle.state(owner, extensionId).selection.revision.id, numericId);
  }
  const retained = authoringDefinition('TaskBeforeCreate', 'sha256:e7e250a249ea72f3261d7e52ac24a45fe42542ccf5fc5eb5de754069ca26f119');
  await assert.rejects(() => f.lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', source: f.fixture.source,
    modelDigest: retained.pins.modelDigest, draftVersion: f.state.draftVersion }, () => {}), { status: 422 });
  assert.equal(f.lifecycle.state(owner, extensionId).draft.id, numericId, 'Mismatched source/model never retries another profile.');
  const fixture = taskCreateGuardFixture({ host: retained, rule: 'priority-note', projectId: f.projectId });
  let state = await f.lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', source: fixture.source,
    modelDigest: retained.pins.modelDigest, draftVersion: f.state.draftVersion }, () => {});
  assert.equal(state.selection.revision.id, numericId);
  assert.equal(state.approved, false);
  assert.equal(state.draft.pins.modelRef.format, 'keir-dcm/3');
  assert.equal(state.draft.pins.compiler, 'keir-compiler-java/0.5.0');
  state = await f.lifecycle.proposeScenarios(owner, { ...input(state), cases: fixture.cases }, () => {});
  state = await f.lifecycle.simulate(owner, input(state), () => {});
  assert.equal(state.evidence.passed, true);
  state = f.lifecycle.approve(owner, { ...input(state), evidenceId: state.evidence.id }, () => {});
  assert.equal(state.selection.revision.id, numericId);
  state = f.lifecycle.activate(owner, { ...input(state), evidenceId: state.approvedEvidenceId, generation: state.selection.generation }, () => {});
  const retainedId = state.selection.revision.id;
  // The retained model's high-priority rule, not the numeric rule, is now selected.
  await assert.rejects(() => f.create({ priority: 'high' }), { code: 'RULE_DENIED' });
  await f.create({ tags: four });
  for (const revisionId of [numericId, retainedId, numericId]) {
    state = f.lifecycle.rollback(owner, { extensionId, revisionId, generation: state.selection.generation }, () => {});
    assert.equal(state.selection.revision.id, revisionId);
    if (revisionId === numericId) await assert.rejects(() => f.create({ tags: four }), { code: 'RULE_DENIED' });
    else await f.create({ tags: four });
  }
  assert.equal(f.lifecycle.evidence(owner, numericProof, extensionId).passed, true);
  assert.equal(f.lifecycle.source(owner, numericId, extensionId).artifact, f.saved.artifact);
});
