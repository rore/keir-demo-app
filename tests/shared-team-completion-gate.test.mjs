import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCompiler } from '../src/compiler.mjs';
import { openData, taskService } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createSharedCompletion } from '../src/shared-completion.mjs';
import { sharedHost, COMPLETION_GATE_CHECK, CREATED_CHECK, GUARD_CHECK, TAG_CHECK } from '../src/shared-completion-contract.mjs';
import { checkTaskBundle, compileTaskBundle, TEAM_GATE_MANIFEST } from '../src/shared-task-bundle.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime } from '../src/team-runtime.mjs';
import { authoredTaskBundle, teamGateOffer } from './fixtures/shared-task-bundle.mjs';

test('native Team field and linked completion gates respect authority, admission and exact originating receipt', async t => {
  const db = openData(':memory:'), compiler = createCompiler(), capability = createTeamCapability(db, { compiler });
  const shared = createSharedCompletion({ db, teamCapability: capability, lifecycle: createLifecycle(db),
    writeReply() { throw new Error('Synthetic lost write reply'); } });
  let beforeCommit;
  const team = createTeamRuntime({ db, sharedCompletion: shared, beforeCompleteCommit: args => beforeCommit?.(args) });
  const tasks = taskService(db, { team, sharedCompletion: shared });
  t.after(async () => { await team.close(); await capability.close(); db.close(); });
  const project = tasks.createProject('maya', { name: 'Receipt intake', mode: 'TEAM' }).id;
  for (const userId of ['leo', 'sam']) teamProjectService(db).addMember('maya', project, { userId });
  const make = (actor, data) => tasks.createTask(actor, { projectId: project, title: 'File receipt', ...data }, { operationId: randomUUID() });
  const original = task => db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(task.id);
  const finish = async (task, actor = 'sam', context) => tasks.completeTask(actor, task.id, context);
  const open = task => assert.equal(tasks.getTask('maya', task.id).status, 'open');
  const models = Object.fromEntries(Object.entries({ TaskBeforeComplete: COMPLETION_GATE_CHECK, TaskCreated: CREATED_CHECK,
    TaskBeforeCreate: GUARD_CHECK, TaskCompleted: TAG_CHECK }).map(([hook, harness]) => {
    const model = sharedHost('TEAM', harness);
    return [hook, { ...JSON.parse(model.dcmBytes), fingerprint: model.pins.modelDigest }];
  }));
  async function activate(offer) {
    let { draftVersion, selection } = capability.state('maya', project);
    const format = TEAM_GATE_MANIFEST;
    const proof = await capability.confirmTaskBundle('maya', project, { expectedDraftVersion: draftVersion,
      expectedSelectionGeneration: selection.generation, offer, format });
    assert.equal(proof.eligible, true);
    const { revisionId, evidenceId } = proof;
    const input = { revisionId, evidenceId, expectedDraftVersion: proof.draftVersion, cases: capability.source('maya', project, revisionId).sourceBundle.cases };
    const { receipt } = await capability.approve('maya', project, { ...input, operationId: randomUUID() });
    const turnOn = expectedSelectionGeneration => capability.activate('maya', project, { ...input, approvalId: receipt.id,
      expectedSelectionGeneration, operationId: randomUUID() });
    if (selection.revisionId) {
      await assert.rejects(turnOn(selection.generation), { status: 409 });
      await capability.deactivate('maya', project, { operationId: randomUUID(), targetRevisionId: selection.revisionId,
        expectedSelectionRevisionId: selection.revisionId, expectedSelectionGeneration: selection.generation });
      ({ selection } = capability.state('maya', project));
    }
    await turnOn(selection.generation);
    return revisionId;
  }
  const prior = await make('sam', { priority: 'high' });
  const fieldOffer = teamGateOffer(project, models);
  const field = await activate(fieldOffer), held = await make('sam', { priority: 'high' });
  assert.equal(original(held).state, 'NO_HOOK');
  assert.equal(original(held).revision_id, field);
  await assert.rejects(finish(held, 'leo'), { status: 403 });
  await assert.rejects(finish(held), { status: 422, message: 'Add notes before completing this task.' });
  open(held);
  assert.equal((await finish(prior)).status, 'completed');
  assert.equal(original(prior).policy_state, 'NO_POLICY');
  tasks.editTask('sam', held.id, { title: held.title, notes: 'Filed.' });
  assert.equal((await finish(held, 'maya')).status, 'completed'); // Completing actor differs from initiator.
  assert.equal(shared.reaction('maya', held.id), null);

  const linkedOffer = suffix => teamGateOffer(project, models, true, suffix);
  const incomplete = linkedOffer(' A');
  incomplete.cases.TaskBeforeComplete = incomplete.cases.TaskBeforeComplete.filter(c => c.linkedStatus !== 'MISSING');
  const missingWitness = await checkTaskBundle(await compileTaskBundle(compiler, 'TEAM', project,
    incomplete, () => {}, undefined, TEAM_GATE_MANIFEST), 'incomplete', 'maya', ['leo', 'sam'], () => {});
  assert.equal(missingWitness.passed, true);
  assert.equal(missingWitness.eligible, false);
  const a = await activate(linkedOffer(' A'));
  const root = await make('sam', { title: 'Check receipt A', tags: ['receipt', 'urgent'] });
  await assert.rejects(finish(root), { status: 503 });
  open(root);
  const absence = await make('sam', { tags: ['receipts'] });
  assert.ok(await shared.run(original(absence).event_id));
  assert.equal(JSON.parse(original(absence).outcome).result.status, 'NO_OP');
  tasks.editTask('sam', absence.id, { tags: ['receipt'] });
  await assert.rejects(finish(absence), { status: 422 });
  open(absence);
  tasks.editTask('sam', absence.id, { tags: ['receipts'] });
  assert.equal((await finish(absence)).status, 'completed');
  const fake = await make('sam', { title: 'Check receipt A' });
  assert.ok(await shared.run(original(fake).event_id));
  await finish(fake);
  assert.ok(await shared.run(original(root).event_id));
  const checked = shared.reaction('sam', root.id, true, 'TaskCreated');
  assert.equal(checked.outcome.classification, 'UNCERTAIN');
  assert.equal(checked.receipt.effect, 'CONFIRMED');
  assert.equal(await shared.run(original(root).event_id), false);
  const child = tasks.getTask('leo', checked.receipt.value.id);
  assert.equal(child.assigneeId, 'leo');
  assert.equal(child.parentTaskId, root.id);
  assert.equal(child.originEventId, original(root).event_id);
  assert.equal(child.dueAt, new Date(Date.parse(root.createdAt) + 120_000).toISOString());
  await assert.rejects(finish(root), { status: 422, message: 'Finish the linked check before completing this task.' });
  await assert.rejects(finish(child), { status: 403 });
  const b = await activate(linkedOffer(' B'));
  assert.equal(original(root).revision_id, a);
  const next = await make('sam', { tags: ['receipt'] });
  assert.equal(original(next).revision_id, b);
  assert.ok(await shared.run(original(next).event_id));
  const wrong = shared.reaction('sam', next.id, false, 'TaskCreated').receipt.value.id;
  await finish({ id: wrong }, 'leo'); // A completed check for a different original is not decisive.
  await assert.rejects(finish(root), { status: 422 });
  const corrupt = await make('sam', { tags: ['receipt'] }), admitted = original(corrupt);
  db.prepare("UPDATE team_admissions SET state='STARTED',claim=? WHERE event_id=?").run(randomUUID(), admitted.event_id);
  db.prepare("UPDATE team_admissions SET receipt=?,child_id=? WHERE event_id=?").run(original(next).receipt, fake.id, admitted.event_id);
  await assert.rejects(finish(corrupt), { status: 503 });
  open(corrupt);
  beforeCommit = ({ taskId }) => {
    if (taskId === root.id) return finish(child, 'leo');
  };
  await assert.rejects(finish(root), { status: 409 });
  beforeCommit = null;
  open(root);
  teamProjectService(db).assign('maya', child.id, 'sam');
  assert.deepEqual(shared.reaction('sam', root.id, false, 'TaskCreated').receipt, checked.receipt);
  assert.equal((await finish(root)).status, 'completed');
  assert.equal(shared.reaction('sam', root.id), null);
  assert.deepEqual(shared.reaction('sam', root.id, false, 'TaskCreated').receipt, checked.receipt);

  beforeCommit = () => db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(project, 'sam');
  await assert.rejects(finish(next), { status: 404 });
  beforeCommit = null;
  open(next);
  teamProjectService(db).addMember('maya', project, { userId: 'sam' });
  let active = true;
  beforeCommit = () => { active = false; };
  await assert.rejects(finish(next, 'sam', { authorize: () => active ? 'sam' : 'leo' }), { status: 401 });
  open(next);
  beforeCommit = () => capability.revoke('maya', project, { operationId: randomUUID(), targetRevisionId: b,
    expectedSelectionRevisionId: b, expectedSelectionGeneration: capability.state('maya', project).selection.generation });
  await assert.rejects(finish(next), { status: 503 });
  open(next);
  assert.equal(shared.reaction('maya', next.id), null);
  assert.equal(db.prepare('SELECT count(*) n FROM shared_completion_events').get().n, 0);
  beforeCommit = null;
  const effects = authoredTaskBundle(project, models);
  const composed = { bindings: { ...fieldOffer.bindings }, cases: { ...fieldOffer.cases } };
  for (const hook of ['TaskCreated', 'TaskCompleted']) {
    composed.bindings[hook] = effects.bindings[hook];
    composed.cases[hook] = effects.cases[hook];
  }
  await activate(composed);
  const layered = await make('sam', { priority: 'high', tags: ['receipt'] });
  await assert.rejects(finish(layered), { status: 422 });
  assert.equal(shared.reaction('sam', layered.id), null);
  tasks.editTask('sam', layered.id, { title: layered.title, notes: 'Filed.' });
  beforeCommit = async ({ taskId }) => {
    assert.equal(taskId, layered.id);
    assert.ok(await shared.run(original(layered).event_id)); // An unrelated readback settles during completion.
  };
  assert.equal((await finish(layered)).status, 'completed');
  assert.equal(shared.reaction('sam', layered.id).state, 'PENDING');
  assert.ok(await shared.run(shared.reaction('sam', layered.id).eventId));
  const archive = shared.reaction('sam', layered.id, true).receipt.value.id;
  assert.equal(tasks.getTask('sam', archive).title, 'Archive receipt');
  assert.equal(db.prepare('SELECT count(*) n FROM shared_completion_events').get().n, 1);
  await assert.rejects(compileTaskBundle(compiler, 'PERSONAL', 'maya', fieldOffer, () => {}, undefined, TEAM_GATE_MANIFEST), { status: 503 });
});
