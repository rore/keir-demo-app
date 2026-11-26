import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler } from '../src/compiler.mjs';
import { sharedHost, COMPLETED_UPDATE_CHECK, CREATED_CHECK, CREATED_UPDATE_CHECK, EXACT_COMPLETED_CHECK, EXACT_CREATED_CHECK, GUARD_CHECK,
  OWNED_GUARD_CHECK, TAG_CHECK } from '../src/shared-completion-contract.mjs';
import { COMPOSED_MANIFEST, bundleProofMatches, checkTaskBundle, compileTaskBundle, readTaskBundle, taskBundleOffer } from '../src/shared-task-bundle.mjs';
import { ownedProjectDefinition, TASK_HOOK } from '../src/extension-catalog.mjs';
import { authoredTaskBundle, composedOffer, createdUpdateOffer, exactCreateOffer, exactLookupUpdateOffer, exactReadOffer, ownedLookupUpdateOffer, ownedProjectOffer, ownedProjectTitle, ownedUpdateTitle,
  sourceUpdateOffer } from './fixtures/shared-task-bundle.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openData, taskEffectService, taskService } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { createSharedCompletion } from '../src/shared-completion.mjs';
import { createTaskCreateGuard } from '../src/task-create-guard.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime } from '../src/team-runtime.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';
import { sharedBundleTables, sharedPersonalAdmissionTable } from '../src/shared-completion-schema.mjs';

const compiler = createCompiler();
const harnesses = { TaskBeforeCreate: GUARD_CHECK, TaskCreated: CREATED_CHECK, TaskCompleted: TAG_CHECK };

function authored(scope, project, suffix = '') {
  const models = Object.fromEntries(Object.entries(harnesses).map(([hook, harness]) => {
    const definition = sharedHost(scope, harness);
    return [hook, { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest }];
  }));
  return authoredTaskBundle(project, models, suffix);
}

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: one exact manifest and proof require all three real hook artifacts`, async () => {
  const project = 'intake-project', subject = scope === 'TEAM' ? project : 'maya';
  const { bindings: { TaskBeforeComplete, ...sources }, cases } = authored(scope, project), artifacts = {};
  for (const [hook, harness] of [['TaskBeforeCreate', GUARD_CHECK], ['TaskCreated', CREATED_CHECK], ['TaskCompleted', TAG_CHECK]]) {
    const result = await compiler.compile(Buffer.from(sources[hook]), { definition: sharedHost(scope, harness) });
    assert.deepEqual(result.diagnostics, []);
    artifacts[hook] = result.artifact;
  }
  const bundle = readTaskBundle(scope, subject, sources, artifacts, cases);
  assert.equal(bundle.manifest.hooks.TaskBeforeComplete, null);
  assert.notEqual(bundle.manifest.hooks.TaskCreated.artifactDigest, bundle.manifest.hooks.TaskCompleted.artifactDigest);
  assert.throws(() => readTaskBundle(scope, subject, sources, { ...artifacts, TaskCreated: artifacts.TaskCompleted }, cases));
  const missing = { ...artifacts }; delete missing.TaskCreated;
  assert.throws(() => readTaskBundle(scope, subject, sources, missing, cases), { status: 503 });
  const checked = await checkTaskBundle(bundle, 'revision', 'maya', [], () => {});
  assert.equal(checked.passed, true);
  assert.equal(checked.eligible, true);
  const wrong = structuredClone(cases);
  wrong.TaskCreated[0].expect.title = 'Wrong receipt';
  assert.throws(() => readTaskBundle(scope, subject, sources, artifacts, wrong, bundle.manifest), { status: 503 });
  const changed = readTaskBundle(scope, subject, sources, artifacts, wrong);
  assert.equal(bundleProofMatches(changed, 'revision', checked), false);
  const failed = await checkTaskBundle(changed, 'revision', 'maya', [], () => {});
  assert.equal(failed.passed, false);
  assert.equal(failed.eligible, false);
  assert.equal(failed.reports.TaskBeforeCreate.passed, true);
  assert.equal(failed.reports.TaskCompleted.passed, true);
  assert.equal(failed.reports.TaskCreated.passed, false);
  const blocked = structuredClone(sources);
  const rejectsChild = JSON.parse(blocked.TaskCreated);
  delete rejectsChild.steps.at(-1).args.notes;
  blocked.TaskCreated = JSON.stringify(rejectsChild);
  const replacement = await compiler.compile(Buffer.from(blocked.TaskCreated), { definition: sharedHost(scope, CREATED_CHECK) });
  const rejectedCases = structuredClone(cases);
  rejectedCases.TaskCreated[0].expect.notes = '';
  const guardAware = readTaskBundle(scope, subject, blocked, { ...artifacts, TaskCreated: replacement.artifact }, rejectedCases);
  const guardFailure = await checkTaskBundle(guardAware, 'revision', 'maya', [], () => {});
  assert.equal(guardFailure.reports.TaskCreated.checks[0].classification, 'BUSINESS_REJECTION');
  assert.equal(guardFailure.reports.TaskCreated.checks[0].observed, null);
  assert.equal(guardFailure.eligible, false);

  const lookupSources = { ...sources };
  const lookupProgram = JSON.parse(sources.TaskCreated);
  const title = 'Existing check';
  lookupProgram.steps.splice(1, 0, { id: 'lookup', call: 'tasks.openMatch',
    args: { projectId: { cel: 'source.projectId' }, title: { literal: title } } });
  lookupProgram.steps[2].let.cel += ' && !lookup.matches';
  lookupSources.TaskCreated = JSON.stringify(lookupProgram);
  const compiled = await compiler.compile(Buffer.from(lookupSources.TaskCreated), { definition: sharedHost(scope, CREATED_CHECK) });
  assert.deepEqual(compiled.diagnostics, []);
  const lookupArtifacts = { ...artifacts, TaskCreated: compiled.artifact };
  const lookupCases = structuredClone(cases);
  const miss = lookupCases.TaskCreated[0];
  lookupCases.TaskCreated = [miss, { ...miss, id: 'exact-hit', openTitles: [title], expect: null },
    { ...miss, id: 'source-only-hit', title, expect: null }];
  const lookup = readTaskBundle(scope, subject, lookupSources, lookupArtifacts, lookupCases);
  const lookupProof = await checkTaskBundle(lookup, 'revision', 'maya', [], () => {});
  assert.equal(lookupProof.eligible, true);
  assert.deepEqual(lookupProof.reports.TaskCreated.checks.map(c => [c.branch, c.openMatches[0]]),
    [['CREATED', { title, matches: false }], ['SKIPPED', { title, matches: true }], ['SKIPPED', { title, matches: true }]]);
  lookupCases.TaskCreated[2].expect = miss.expect;
  const wrongLookup = readTaskBundle(scope, subject, lookupSources, lookupArtifacts, lookupCases);
  assert.equal((await checkTaskBundle(wrongLookup, 'revision', 'maya', [], () => {})).eligible, false);

  const offer = composedOffer({ bindings: { ...sources, TaskCreated: null, TaskBeforeComplete }, cases }, project);
  const subset = taskBundleOffer(offer, COMPOSED_MANIFEST);
  const bytes = { TaskBeforeCreate: artifacts.TaskBeforeCreate, TaskCompleted: artifacts.TaskCompleted };
  const exact = readTaskBundle(scope, subject, subset.sources, bytes, subset.cases, undefined, COMPOSED_MANIFEST);
  assert.equal(exact.manifest.hooks.TaskCreated, null);
  assert.throws(() => readTaskBundle(scope, subject, subset.sources, { ...bytes, TaskCompleted: undefined }, subset.cases, exact.manifest), { status: 503 });
  const missingAbsence = structuredClone(exact.manifest); delete missingAbsence.hooks.TaskCreated;
  assert.throws(() => readTaskBundle(scope, subject, subset.sources, bytes, subset.cases, missingAbsence), { status: 503 });
  assert.throws(() => taskBundleOffer({ ...offer, cases: { ...offer.cases, TaskCreated: [] } }, COMPOSED_MANIFEST), { status: 400 });
  const proof = await checkTaskBundle(exact, 'revision', 'maya', [], () => {});
  assert.equal(proof.eligible, true);
  assert.equal(bundleProofMatches(exact, 'revision', { ...proof, reports: { TaskCompleted: proof.reports.TaskCompleted } }), false);
  assert.equal(bundleProofMatches(exact, 'revision', checked), false);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: exact admitted three-hook revision runs both attempts without recursion`, async t => {
  const teamScope = scope === 'TEAM', actor = teamScope ? 'leo' : 'maya', permit = () => 'maya';
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler }), teamCapability = createTeamCapability(db, { compiler });
  const guard = createTaskCreateGuard({ db, lifecycle, teamCapability, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
  const shared = createSharedCompletion({ db, lifecycle, teamCapability, guard, clock: () => 0,
    writeReply() { throw new Error('Synthetic lost reply'); } });
  let beforeComplete;
  const team = createTeamRuntime({ db, sharedCompletion: shared, beforeCompleteCommit: context => beforeComplete?.(context) });
  const tasks = taskService(db, { guard, team, sharedCompletion: shared });
  t.after(async () => { await team.close(); await guard.close(); await teamCapability.close(); db.close(); });
  const project = tasks.createProject('maya', { name: 'Filing desk', mode: scope }).id;
  if (teamScope) teamProjectService(db).addMember('maya', project, { userId: actor });
  const create = (title, notes) => tasks.createTask(actor, { projectId: project, title, notes, tags: ['receipt'] }, { operationId: randomUUID() });
  const old = await create('Before selection', 'Original task.');
  const unrelated = db.prepare('SELECT * FROM extension_selections WHERE owner_id=? ORDER BY hook_id').all('sam');
  const { extensionId } = teamScope ? {} : admitTaskDraft(db, lifecycle, { owner: actor, name: 'Filing rules' });
  async function activate(suffix) {
    const offer = authored(scope, project, suffix), { cases } = offer;
    if (teamScope) {
      const state = teamCapability.state('maya', project);
      const result = await teamCapability.confirmTaskBundle('maya', project, { expectedDraftVersion: state.draftVersion,
        expectedSelectionGeneration: state.selection.generation, offer }, permit);
      assert.equal(result.eligible, true);
      const input = { expectedDraftVersion: result.draftVersion, revisionId: result.revisionId, evidenceId: result.evidenceId, cases };
      const approval = await teamCapability.approve('maya', project, { ...input, operationId: randomUUID() }, permit);
      if (state.selection.revisionId) {
        await assert.rejects(teamCapability.activate('maya', project, { ...input, operationId: randomUUID(), approvalId: approval.receipt.id,
          expectedSelectionGeneration: state.selection.generation }, permit), { status: 409 });
        await teamCapability.deactivate('maya', project, { operationId: randomUUID(), targetRevisionId: state.selection.revisionId,
          expectedSelectionRevisionId: state.selection.revisionId, expectedSelectionGeneration: state.selection.generation }, permit);
      }
      await teamCapability.activate('maya', project, { ...input, operationId: randomUUID(), approvalId: approval.receipt.id,
        expectedSelectionGeneration: teamCapability.state('maya', project).selection.generation }, permit);
      return result.revisionId;
    }
    const state = lifecycle.state(actor, extensionId), selections = lifecycle.bundleSelection(actor);
    const result = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion,
      selections, offer }, permit);
    assert.equal(result.eligible, true);
    const input = { extensionId, revisionId: result.revisionId, evidenceId: result.evidenceId, draftVersion: result.draftVersion };
    lifecycle.approve(actor, input, permit);
    const generations = Object.fromEntries(Object.entries(selections).map(([hook, item]) => [hook, item.generation]));
    assert.throws(() => lifecycle.activateTaskBundle(actor, { ...input, generations: { ...generations, TaskCreated: 99 } }, permit), { status: 409 });
    assert.deepEqual(lifecycle.bundleSelection(actor), selections);
    lifecycle.activateTaskBundle(actor, { ...input, generations }, permit);
    return result.revisionId;
  }
  const a = await activate(' A');
  await assert.rejects(create('No notes', ' '), { status: 422, code: 'RULE_DENIED' });
  const root = await create('Receipt', 'Good notes.');
  const b = await activate(' B');
  assert.deepEqual(db.prepare('SELECT * FROM extension_selections WHERE owner_id=? ORDER BY hook_id').all('sam'), unrelated);
  const fresh = await create('Later receipt', 'Good notes.');
  await tasks.completeTask(actor, old.id);
  assert.equal(shared.reaction(actor, old.id), null);
  for (const [task, revision, suffix] of [[root, a, ' A'], [fresh, b, ' B']]) {
    const created = shared.reaction(actor, task.id, false, 'TaskCreated');
    assert.equal(created.revisionId, revision);
    if (teamScope && task === root) {
      beforeComplete = async ({ taskId }) => {
        assert.equal(taskId, task.id);
        assert.equal(await shared.run(created.eventId), true);
      };
      assert.equal((await tasks.completeTask(actor, task.id)).status, 'completed');
      beforeComplete = null;
    } else assert.equal(await shared.run(created.eventId), true);
    assert.equal(await shared.run(created.eventId), false);
    const actual = shared.reaction(actor, task.id, true, 'TaskCreated');
    assert.equal(actual.outcome.classification, 'UNCERTAIN');
    assert.equal(actual.receipt.effect, 'CONFIRMED');
    const child = tasks.getTask(actor, actual.receipt.value.id);
    assert.equal(child.title, 'Check receipt' + suffix);
    await tasks.completeTask(actor, child.id);
    assert.equal(shared.reaction(actor, child.id), null);
    assert.equal(shared.reaction(actor, child.id, false, 'TaskCreated'), null);
    if (!teamScope) assert.deepEqual(db.prepare('SELECT hook_id,state,revision_id FROM task_events WHERE source_task_id=?').all(child.id)
      .map(({ hook_id, state, revision_id }) => [hook_id, state, revision_id]), [['TaskCompleted', 'NO_BINDING', null]]);
    await tasks.completeTask(actor, task.id);
    const completed = shared.reaction(actor, task.id);
    assert.equal((await tasks.completeTask(actor, task.id)).status, 'completed');
    assert.equal(shared.reaction(actor, task.id).eventId, completed.eventId);
    assert.equal(completed.revisionId, revision);
    assert.notEqual(actual.originalKey, completed.originalKey);
    assert.equal(await shared.run(completed.eventId), true);
    assert.equal(await shared.run(completed.eventId), false);
    const archive = shared.reaction(actor, task.id, true);
    assert.equal(archive.outcome.classification, 'UNCERTAIN');
    assert.equal(tasks.getTask(actor, archive.receipt.value.id).title, 'Archive receipt' + suffix);
  }
  const revoked = await create('Revoked before dispatch', 'Good notes.');
  const started = shared.reaction(actor, revoked.id, false, 'TaskCreated');
  if (teamScope) {
    const selection = teamCapability.state('maya', project).selection;
    beforeComplete = () => db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(project, actor);
    await assert.rejects(tasks.completeTask(actor, revoked.id), { status: 404 });
    teamProjectService(db).addMember('maya', project, { userId: actor });
    beforeComplete = () => teamCapability.revoke('maya', project, { operationId: randomUUID(), targetRevisionId: b,
      expectedSelectionRevisionId: b, expectedSelectionGeneration: selection.generation }, permit);
    await assert.rejects(tasks.completeTask(actor, revoked.id), { status: 503 });
    beforeComplete = null;
  } else lifecycle.disable(actor, { extensionId, generation: lifecycle.state(actor, extensionId).selection.generation }, permit);
  await assert.rejects(shared.run(started.eventId));
  await assert.rejects(async () => tasks.completeTask(actor, revoked.id));
  assert.equal(shared.reaction(actor, revoked.id, true, 'TaskCreated').receipt, null);
  assert.ok(shared.reaction(actor, fresh.id, true, 'TaskCreated').receipt);
  assert.equal(tasks.getTask(actor, revoked.id).status, 'open');
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: standalone created and a pinned subset without created`, async t => {
  const isTeam = scope === 'TEAM', actor = isTeam ? 'leo' : 'maya', permit = () => 'maya';
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler }), capability = createTeamCapability(db, { compiler });
  const guard = createTaskCreateGuard({ db, lifecycle, teamCapability: capability, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
  const shared = createSharedCompletion({ db, lifecycle, teamCapability: capability, guard, clock: () => 0 });
  const team = createTeamRuntime({ db, sharedCompletion: shared }), tasks = taskService(db, { guard, team, sharedCompletion: shared });
  t.after(async () => { await team.close(); await guard.close(); await capability.close(); db.close(); });
  const project = tasks.createProject('maya', { name: 'Receipt desk', mode: scope }).id;
  if (isTeam) teamProjectService(db).addMember('maya', project, { userId: actor });
  const create = (title, notes = 'Filed.') => tasks.createTask(actor, { projectId: project, title, notes, tags: ['receipt'] }, { operationId: randomUUID() });
  const old = await create('Before selection');
  const standalone = ['TaskCreated'], paired = ['TaskBeforeCreate', 'TaskCompleted'];
  const item = () => isTeam ? null : admitTaskDraft(db, lifecycle, { owner: actor, name: 'Filing' }).extensionId;
  const createdItem = item(), pairedItem = item();
  const personalSlots = () => lifecycle.bundleSelection(actor);
  async function prepare(hooks, extensionId, suffix) {
    const initial = authored(scope, project, suffix);
    for (const hook of Object.keys(initial.bindings)) if (!hooks.includes(hook)) initial.bindings[hook] = null;
    if (hooks === standalone) {
      const program = JSON.parse(initial.bindings.TaskCreated);
      delete program.steps.at(-1).args.notes;
      initial.bindings.TaskCreated = JSON.stringify(program);
      initial.cases.TaskCreated[0].expect.notes = '';
    }
    const offer = composedOffer(initial, project), format = COMPOSED_MANIFEST;
    if (isTeam) {
      const state = capability.state('maya', project), generation = state.selection.generation;
      const proof = await capability.confirmTaskBundle('maya', project, { expectedDraftVersion: state.draftVersion, expectedSelectionGeneration: generation, offer, format }, permit);
      assert.equal(proof.eligible, true);
      const { revisionId, evidenceId, draftVersion: expectedDraftVersion } = proof;
      const input = { revisionId, evidenceId, expectedDraftVersion, cases: capability.source('maya', project, revisionId).sourceBundle.cases };
      const { receipt } = await capability.approve('maya', project, { ...input, operationId: randomUUID() }, permit);
      return { revisionId, async activate() {
        const turnOn = expectedSelectionGeneration => capability.activate('maya', project, { ...input, approvalId: receipt.id, expectedSelectionGeneration, operationId: randomUUID() }, permit);
        if (state.selection.revisionId) {
          await assert.rejects(turnOn(generation), { status: 409 });
          await capability.deactivate('maya', project, { operationId: randomUUID(), targetRevisionId: state.selection.revisionId,
            expectedSelectionRevisionId: state.selection.revisionId, expectedSelectionGeneration: generation }, permit);
          await assert.rejects(turnOn(generation), { status: 409 });
        }
        await turnOn(capability.state('maya', project).selection.generation);
      } };
    }
    const state = lifecycle.state(actor, extensionId), prior = personalSlots();
    const selections = Object.fromEntries(hooks.map(hook => [hook, prior[hook]]));
    const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion, selections, offer, format }, permit);
    assert.equal(proof.eligible, true);
    const { revisionId, evidenceId, draftVersion } = proof;
    const input = { extensionId, revisionId, evidenceId, draftVersion };
    lifecycle.approve(actor, input, permit);
    const generations = Object.fromEntries(hooks.map(hook => [hook, selections[hook].generation]));
    return { revisionId, activate(changes = {}) { return lifecycle.activateTaskBundle(actor, { ...input, generations: { ...generations, ...changes } }, permit); } };
  }
  const c = await prepare(standalone, createdItem, ' standalone');
  await c.activate();
  const alone = await create('After-save only', '');
  const saved = shared.reaction(actor, alone.id, false, 'TaskCreated');
  assert.equal(saved.revisionId, c.revisionId);
  assert.ok(await shared.run(saved.eventId));
  const child = tasks.getTask(actor, shared.reaction(actor, alone.id, true, 'TaskCreated').receipt.value.id);
  assert.equal(child.title, 'Check receipt standalone');
  await tasks.completeTask(actor, child.id);
  await tasks.completeTask(actor, alone.id);
  assert.equal(shared.reaction(actor, alone.id), null);
  assert.equal(shared.reaction(actor, old.id, false, 'TaskCreated'), null);
  const priorSlot = personalSlots().TaskCreated;
  const a = await prepare(paired, pairedItem, ' A');
  await a.activate();
  await assert.rejects(create('Fails guard', ''), { code: 'RULE_DENIED' });
  const rootA = await create('Under A');
  if (isTeam) {
    assert.deepEqual({ ...db.prepare('SELECT state,policy_state,revision_id FROM team_admissions WHERE source_task_id=?').get(rootA.id) },
      { state: 'NO_HOOK', policy_state: 'PINNED', revision_id: a.revisionId });
    assert.equal(shared.reaction(actor, rootA.id, false, 'TaskCreated'), null);
  } else {
    const independent = shared.reaction(actor, rootA.id, false, 'TaskCreated');
    assert.equal(independent.revisionId, c.revisionId);
    assert.ok(await shared.run(independent.eventId));
    const child = tasks.getTask(actor, shared.reaction(actor, rootA.id, true, 'TaskCreated').receipt.value.id);
    assert.equal(child.notes, ''); // The absent save hook does not borrow the separately selected guard.
    assert.equal(db.prepare('SELECT revision_id FROM shared_personal_completion_pins').get().revision_id, a.revisionId);
    const partial = await prepare(['TaskCompleted'], item(), ' partial');
    assert.throws(() => partial.activate(), { status: 409 });
    assert.equal(personalSlots().TaskCompleted.revisionId, a.revisionId);
  }
  const b = await prepare(paired, pairedItem, ' B');
  if (!isTeam) {
    const before = personalSlots();
    assert.throws(() => b.activate({ TaskBeforeCreate: before.TaskBeforeCreate.generation + 1 }), { status: 409 });
    assert.deepEqual(personalSlots(), before);
  }
  await b.activate();
  assert.deepEqual(personalSlots().TaskCreated, priorSlot);
  const rootB = await create('Under B');
  await tasks.completeTask(actor, old.id);
  assert.equal(shared.reaction(actor, old.id), null);
  for (const [root, expected, title] of [[rootA, a.revisionId, 'Archive receipt A'], [rootB, b.revisionId, 'Archive receipt B']]) {
    await tasks.completeTask(actor, root.id);
    const outcome = shared.reaction(actor, root.id);
    assert.equal(outcome.revisionId, expected);
    assert.ok(await shared.run(outcome.eventId));
    assert.equal(tasks.getTask(actor, shared.reaction(actor, root.id, true).receipt.value.id).title, title);
  }
  if (!isTeam) {
    const open = await create('Before disabling the pair');
    const other = await prepare(paired, admitTaskDraft(db, lifecycle, { owner: actor, name: 'Other filing rule' }).extensionId, ' C');
    const selected = personalSlots();
    assert.throws(() => other.activate(), { status: 409 });
    assert.deepEqual(personalSlots(), selected);
    const oldPins = db.prepare(`SELECT * FROM ${sharedPersonalAdmissionTable} WHERE revision_id=? AND revoked_at IS NULL`).all(b.revisionId);
    assert.equal(oldPins.length, 2);
    assert.throws(() => db.prepare(`UPDATE ${sharedPersonalAdmissionTable} SET selection_generation=0 WHERE event_id=?`).run(oldPins[0].event_id), /immutable/);
    lifecycle.disable(actor, { extensionId: pairedItem, generation: personalSlots().TaskCompleted.generation }, permit);
    other.activate(Object.fromEntries(paired.map(hook => [hook, personalSlots()[hook].generation])));
    await assert.rejects(async () => tasks.completeTask(actor, open.id), { status: 409 });
    assert.equal(tasks.getTask(actor, open.id).status, 'open');
    assert.equal(db.prepare(`SELECT revision_id FROM ${sharedPersonalAdmissionTable} WHERE event_id=?`).get(oldPins[1].event_id).revision_id, b.revisionId);
    assert.equal(personalSlots().TaskCompleted.revisionId, other.revisionId);
    assert.deepEqual(personalSlots().TaskCreated, priorSlot);
  }
});

test('Personal completion keeps its exact admission generation across same-item replacement', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler });
  const shared = createSharedCompletion({ db, lifecycle, clock: () => 0 });
  const tasks = taskService(db, { sharedCompletion: shared }), actor = 'maya', permit = () => actor;
  t.after(() => db.close());
  const projectId = tasks.createProject(actor, { name: 'Generation check' }).id;
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const slot = () => lifecycle.bundleSelection(actor);
  db.prepare("UPDATE extension_selections SET generation=5 WHERE owner_id=? AND hook_id='TaskCompleted'").run(actor);
  async function activate(suffix) {
    const initial = authored('PERSONAL', projectId, suffix);
    initial.bindings.TaskBeforeCreate = null;
    const { TaskBeforeCreate, ...selections } = slot();
    const state = lifecycle.state(actor, extensionId);
    const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion,
      selections, offer: composedOffer(initial, projectId), format: COMPOSED_MANIFEST }, permit);
    lifecycle.approve(actor, { extensionId, ...proof }, permit);
    lifecycle.activateTaskBundle(actor, { extensionId, ...proof, generations: Object.fromEntries(Object.entries(selections).map(([h, s]) => [h, s.generation])) }, permit);
    return proof.revisionId;
  }
  const a = await activate(' A'), admitted = slot();
  const create = (service, title) => service.createTask(actor, { projectId, title, tags: ['receipt'] }, { operationId: randomUUID() });
  const root = await create(tasks, 'Under A'), missing = await create(tasks, 'Missing future pin');
  // Reproduce a saved /2 anchor from before the correction: admission verified it but wrote no completion side pin.
  const oldTasks = taskService(db, { sharedCompletion: { ...shared, verifyPersonalAdmission: selected => { shared.verifyPersonalAdmission(selected); } } });
  const legacy = await create(oldTasks, 'Previously admitted /2');
  const event = (task, hook) => db.prepare('SELECT * FROM task_events WHERE source_task_id=? AND hook_id=?').get(task.id, hook);
  const pin = task => db.prepare(`SELECT * FROM ${sharedPersonalAdmissionTable} WHERE event_id=?`).get(event(task, 'TaskCreated').event_id);
  const bytes = event(legacy, 'TaskCreated').pins;
  assert.equal(pin(legacy), undefined);
  assert.equal(JSON.parse(bytes).completionPin, undefined);
  assert.equal(JSON.parse(event(root, 'TaskCreated').pins).completionPin, true);
  assert.equal(pin(root).selection_generation, admitted.TaskCompleted.generation);
  db.prepare(`DELETE FROM ${sharedPersonalAdmissionTable} WHERE event_id=?`).run(event(missing, 'TaskCreated').event_id);

  await activate(' B');
  for (const [task, generation] of [[root, admitted.TaskCompleted.generation], [legacy, admitted.TaskCreated.generation]]) {
    const created = event(task, 'TaskCreated');
    assert.equal(created.revision_id, a);
    assert.equal(created.selection_generation, admitted.TaskCreated.generation);
    assert.ok(await shared.run(created.event_id));
    assert.equal(shared.reaction(actor, task.id, true, 'TaskCreated').receipt.effect, 'CONFIRMED');
    await tasks.completeTask(actor, task.id);
    const completed = event(task, 'TaskCompleted');
    assert.equal(completed.revision_id, a);
    assert.equal(completed.selection_generation, generation);
    assert.notEqual(completed.original_key, created.original_key);
    assert.ok(await shared.run(completed.event_id));
    const { receipt, originalKey } = shared.reaction(actor, task.id, true);
    assert.equal(originalKey, completed.original_key);
    assert.equal(receipt.effect, 'CONFIRMED');
    assert.equal(tasks.getTask(actor, receipt.value.id).title, 'Archive receipt A');
  }
  assert.equal(event(legacy, 'TaskCreated').pins, bytes);
  await assert.rejects(async () => tasks.completeTask(actor, missing.id), { status: 503 });
  assert.equal(tasks.getTask(actor, missing.id).status, 'open');
  assert.equal(event(missing, 'TaskCompleted'), undefined);
});

for (const hook of ['TaskCreated', 'TaskCompleted']) test(`Personal ${hook}: owned-project effects use exact independent project identities`, async t => {
  const actor = 'maya', permit = () => actor, db = openData(':memory:');
  const lifecycle = createLifecycle(db, { compiler });
  const guard = createTaskCreateGuard({ db, lifecycle, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
  let beforeWrite, replies = 0;
  const shared = createSharedCompletion({ db, lifecycle, guard, clock: () => 0, beforeWrite: () => beforeWrite?.(),
    writeReply() { replies++; throw new Error('Synthetic lost write reply'); } });
  const tasks = taskService(db, { guard, sharedCompletion: shared });
  t.after(async () => { await guard.close(); db.close(); });
  const project = (owner, name, mode = 'PERSONAL') => tasks.createProject(owner, { name, mode }).id;
  const source = project(actor, 'Accounts'), destination = project(actor, 'Accounts');
  const lookup = hook === 'TaskCreated' ? project(actor, 'Invoice index') : destination;
  const foreign = project('leo', 'Secret'), team = project(actor, 'Shared', 'TEAM');
  const definition = ownedProjectDefinition(hook), model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const offer = ownedProjectOffer(model, hook, source, destination, lookup);
  const program = JSON.parse(offer.bindings[hook]);
  program.steps.at(-1).args.priority = { cel: 'source.priority' };
  offer.bindings[hook] = JSON.stringify(program);
  offer.cases[hook].forEach(c => { c.priority = 'low'; if (c.expect) c.expect.priority = 'low'; });
  const guardModel = sharedHost('PERSONAL', GUARD_CHECK), { domain } = JSON.parse(guardModel.dcmBytes);
  offer.bindings.TaskBeforeCreate = JSON.stringify({ language: 'keir/3', name: 'destination-check',
    domain: { ...domain, fingerprint: guardModel.pins.modelDigest }, entrypoint: 'TaskBeforeCreate',
    steps: [{ id: 'destination', let: { literal: destination, type: 'ProjectId' } },
      { id: 'hold', let: { cel: 'input.projectId == destination && input.priority == "high"' } }],
    return: { record: { decision: { cel: 'hold ? "DENY" : "ALLOW"' }, message: { cel: 'hold ? "Choose another priority." : ""' } } },
  });
  const facts = { projectId: destination, tags: [], hasDueDate: false, hasNotes: false, openTitles: [] };
  offer.cases.TaskBeforeCreate = [
    { ...facts, id: 'normal', priority: 'normal', expect: { decision: 'ALLOW', message: '' } },
    { ...facts, id: 'high', priority: 'high', expect: { decision: 'DENY', message: 'Choose another priority.' } },
  ];
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const slots = lifecycle.bundleSelection(actor), selections = { [hook]: slots[hook], TaskBeforeCreate: slots.TaskBeforeCreate };
  const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0, selections, offer, format: COMPOSED_MANIFEST }, permit);
  assert.equal(proof.eligible, true);
  const input = { extensionId, ...proof };
  lifecycle.approve(actor, input, permit);
  lifecycle.activateTaskBundle(actor, { ...input, generations: Object.fromEntries(Object.entries(selections).map(([k, v]) => [k, v.generation])) }, permit);
  const make = (projectId, title, priority = 'low', tags = []) => tasks.createTask(actor,
    { projectId, title, priority, tags }, { operationId: randomUUID() });
  const read = (task, reconcile = false) => shared.reaction(actor, task.id, reconcile, hook);
  const trigger = async (title, priority) => {
    const task = await make(source, title, priority, ['invoices']);
    if (hook === 'TaskCompleted') await tasks.completeTask(actor, task.id);
    return task;
  };
  await make(source, ownedProjectTitle);
  await make(lookup, ownedProjectTitle.toLowerCase()); // Case-sensitive target matching.
  const blocked = await trigger('Blocked by destination guard', 'high');
  await shared.run(read(blocked).eventId);
  assert.equal(read(blocked).outcome.classification, 'BUSINESS_REJECTION');
  assert.equal(read(blocked).receipt, null);
  assert.equal(replies, 0);
  const raced = await trigger('Changed lookup');
  beforeWrite = () => make(lookup, ownedProjectTitle);
  await shared.run(read(raced).eventId);
  beforeWrite = undefined;
  assert.equal(read(raced).outcome.classification, 'BUSINESS_REJECTION');
  const hit = await trigger('Matching task in lookup project');
  await shared.run(read(hit).eventId);
  assert.equal(read(hit).outcome.result.status, 'NO_OP');
  const match = tasks.listTasks(actor, lookup).find(task => task.title === ownedProjectTitle);
  tasks.editTask(actor, match.id, { title: 'Not the same', notes: match.notes });
  const unavailable = await trigger('Lookup scope changes before dispatch');
  const setMode = (projectId, mode) => db.prepare('UPDATE projects SET mode=? WHERE id=?').run(mode, projectId);
  setMode(lookup, 'TEAM');
  await shared.run(read(unavailable).eventId);
  setMode(lookup, 'PERSONAL');
  assert.equal(read(unavailable).outcome.classification, 'BUSINESS_REJECTION');
  assert.equal(read(unavailable).receipt, null);
  const moved = await trigger('Destination scope changes before write');
  beforeWrite = () => setMode(destination, 'TEAM');
  await shared.run(read(moved).eventId);
  beforeWrite = undefined;
  setMode(destination, 'PERSONAL');
  assert.equal(read(moved).receipt, null);
  assert.equal(replies, 0);
  const root = await trigger('Lunar invoices');
  tasks.renameProject(actor, destination, { name: 'Accounts archive' });
  await shared.run(read(root).eventId);
  const result = read(root, true);
  assert.equal(result.outcome.classification, 'UNCERTAIN');
  assert.equal(result.receipt.effect, 'CONFIRMED');
  assert.equal(result.destinationProjectId, destination);
  assert.equal(result.reconciliation.destinationProjectId, destination);
  const child = tasks.getTask(actor, result.receipt.value.id);
  assert.equal(child.projectId, destination);
  assert.equal(child.title, ownedProjectTitle);
  assert.equal(child.priority, 'low');
  assert.equal(shared.reaction(actor, child.id, false, 'TaskCreated'), null);
  await tasks.completeTask(actor, child.id);
  // A save guard plus completion requires a lifetime pin, which the generated task has never held.
  assert.equal(shared.reaction(actor, child.id), null);
  assert.equal(db.prepare("SELECT state FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(child.id).state, 'NO_BINDING');
  assert.deepEqual(read(root).receipt, result.reconciliation.receipt);
  assert.equal(await shared.run(result.eventId), false);
  assert.equal(replies, 1);
  assert.equal(lifecycle.evidence(actor, proof.evidenceId, extensionId).eligible, true);
  await assert.rejects(compileTaskBundle(compiler, 'TEAM', team, ownedProjectOffer(model, hook, team, foreign), () => {}, undefined, COMPOSED_MANIFEST),
    { status: 503 });
});

for (const hook of ['TaskCreated', 'TaskCompleted']) test(`Personal ${hook}: fixed same-project lookup needs both independent witnesses`, async () => {
  const actor = 'maya', projectId = 'intake';
  const definition = ownedProjectDefinition(hook, '5');
  const model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const reference = { id: 'reference-task', projectId: 'references', title: 'Exact reference' };
  const offer = exactLookupUpdateOffer(projectId, 'index', model, hook, reference);
  for (const example of offer.cases[hook]) {
    const lookup = example.openProjects.find(project => project.projectId === 'index');
    example.openProjects = [{ ...lookup, projectId }];
  }
  const program = JSON.parse(offer.bindings[hook]);
  const lookup = program.steps.find(step => step.call === 'tasks.openMatch');
  lookup.args.projectId.literal = projectId;
  offer.bindings[hook] = JSON.stringify(program);
  const compile = () => compileTaskBundle(compiler, 'PERSONAL', actor, offer, () => {}, undefined, COMPOSED_MANIFEST);
  const check = bundle => checkTaskBundle(bundle, 'revision', actor, [], () => {});
  const unrestricted = await check(await compile());
  assert.equal(unrestricted.passed, true);
  assert.equal(unrestricted.eligible, false, 'Same-project examples cannot prove an unrestricted cross-project rule.');

  const condition = program.steps.find(step => step.id === 'applies');
  program.steps.splice(program.steps.indexOf(condition), 0, { id: 'fixedProject', let: { literal: projectId, type: 'ProjectId' } });
  condition.let.cel += ' && source.projectId == fixedProject';
  offer.bindings[hook] = JSON.stringify(program);
  const bundle = await compile();
  const qualified = await check(bundle);
  assert.equal(qualified.passed, true);
  assert.equal(qualified.eligible, true);
  assert.ok(bundleProofMatches(bundle, 'revision', qualified));

  for (const witness of ['wrong-reference', 'opposite-match']) {
    const cases = { [hook]: bundle.cases[hook].filter(example => example.id !== witness) };
    const partial = readTaskBundle('PERSONAL', actor, bundle.sources, bundle.artifacts, cases, undefined, COMPOSED_MANIFEST);
    const result = await check(partial);
    assert.equal(result.passed, true);
    assert.equal(result.eligible, false, `Missing ${witness} cannot qualify approval.`);
  }
});

for (const hook of ['TaskCreated', 'TaskCompleted']) for (const exact of [false, true])
test(`Personal ${hook}: owned lookup${exact ? ' and exact reference' : ''} fences one source update and preserves its receipt across restart`, async t => {
  const actor = 'maya', permit = () => actor, positive = !exact && hook === 'TaskCreated';
  const dir = mkdtempSync(join(tmpdir(), 'daymark-owned-update-')), path = join(dir, 'app.sqlite');
  let db, lifecycle, shared, tasks, beforeWrite, writes = 0;
  function open() {
    db = openData(path);
    lifecycle = createLifecycle(db, { compiler });
    shared = createSharedCompletion({ db, lifecycle, clock: () => 0, beforeWrite: () => beforeWrite?.(),
      writeReply() { writes++; throw new Error('Synthetic lost source update reply'); } });
    tasks = taskService(db, { sharedCompletion: shared });
  }
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  open();
  const source = tasks.createProject(actor, { name: 'Intake' }).id, lookup = tasks.createProject(actor, { name: 'Index' }).id;
  let reference;
  if (exact) {
    const projectId = tasks.createProject(actor, { name: 'References' }).id;
    const title = 'Exact reference';
    for (const priority of ['low', 'high']) {
      const task = await tasks.createTask(actor, { projectId, title, priority }, { operationId: randomUUID() });
      reference ??= { id: task.id, title, projectId };
    }
  }
  const definition = ownedProjectDefinition(hook, exact ? '5' : '2');
  const model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const offer = exact ? exactLookupUpdateOffer(source, lookup, model, hook, reference) : ownedLookupUpdateOffer(source, lookup, model, hook, positive);
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const selection = lifecycle.bundleSelection(actor)[hook], selections = { [hook]: selection };
  const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0, selections,
    offer, format: COMPOSED_MANIFEST }, permit);
  assert.equal(proof.eligible, true);
  lifecycle.approve(actor, { extensionId, ...proof }, permit);
  lifecycle.activateTaskBundle(actor, { extensionId, ...proof, generations: { [hook]: selection.generation } }, permit);
  const dueAt = offer.cases[hook][0].sourceDueAt;
  const make = (projectId, title, tags = []) => tasks.createTask(actor,
    { projectId, title, notes: 'Keep\0both', tags, dueAt, priority: 'low' }, { operationId: randomUUID() });
  const trigger = async title => {
    const task = await make(source, title, ['intake']);
    return hook === 'TaskCompleted' ? tasks.completeTask(actor, task.id) : task;
  };
  const read = (task, reconcile = false) => shared.reaction(actor, task.id, reconcile, hook);
  const settle = async task => {
    assert.equal(await shared.run(read(task).eventId), true);
    return read(task);
  };
  const patchTitle = (task, title) => tasks.editTask(actor, task.id, { title, notes: task.notes });
  await make(source, ownedUpdateTitle);
  await make(lookup, ownedUpdateTitle.toLowerCase());
  const match = await make(lookup, positive ? 'Near name' : ownedUpdateTitle);
  if (exact) {
    const priority = value => tasks.editTask(actor, reference.id, { priority: value });
    patchTitle(match, 'Changed name');
    const distractor = await trigger('Same title with the wrong ID');
    assert.equal((await settle(distractor)).outcome.result.status, 'NO_OP');
    assert.deepEqual(tasks.getTask(actor, distractor.id), distractor);
    priority('high');
    const race = await trigger('Reference changes before commit');
    beforeWrite = () => priority('low');
    assert.equal((await settle(race)).outcome.error.code, 'ACCESS_DENIED');
    assert.deepEqual(tasks.getTask(actor, race.id), race);
    priority('high');
    beforeWrite = undefined;
    const referenceMode = value => db.prepare('UPDATE projects SET mode=? WHERE id=?').run(value, reference.projectId);
    const inaccessible = await trigger('Reference leaves Personal scope');
    referenceMode('TEAM');
    assert.equal((await settle(inaccessible)).outcome.classification, 'BUSINESS_REJECTION');
    assert.deepEqual(tasks.getTask(actor, inaccessible.id), inaccessible);
    referenceMode('PERSONAL');
    patchTitle(match, ownedUpdateTitle);
  }
  const skipped = await trigger('Skip this source');
  assert.equal((await settle(skipped)).outcome.result.status, 'NO_OP');
  assert.deepEqual(tasks.getTask(actor, skipped.id), skipped);
  patchTitle(match, positive ? ownedUpdateTitle : 'Changed name');
  const race = await trigger('Lookup changes before commit');
  beforeWrite = () => patchTitle(match, positive ? 'Changed name' : ownedUpdateTitle);
  assert.equal((await settle(race)).outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(tasks.getTask(actor, race.id), race);
  patchTitle(match, positive ? ownedUpdateTitle : 'Changed name');
  const mode = mode => db.prepare('UPDATE projects SET mode=? WHERE id=?').run(mode, lookup);
  const denied = await trigger('Lookup leaves Personal scope');
  beforeWrite = () => mode('TEAM');
  assert.equal((await settle(denied)).outcome.classification, 'BUSINESS_REJECTION');
  mode('PERSONAL');
  assert.deepEqual(tasks.getTask(actor, denied.id), denied);
  const edited = await trigger('Intervening edit and restore');
  beforeWrite = () => {
    const edit = db.prepare('UPDATE tasks SET priority=? WHERE id=?');
    edit.run('normal', edited.id); edit.run('low', edited.id);
  };
  assert.equal((await settle(edited)).outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(tasks.getTask(actor, edited.id), edited);
  beforeWrite = undefined;
  const protection = hook === 'TaskCreated' ? ['shared_created_updates', ' AND valid=1'] : ['shared_priority_fences', ''];
  const missing = await trigger('Missing edit protection');
  db.prepare(`DELETE FROM ${protection[0]} WHERE source_id=?`).run(missing.id);
  assert.equal((await settle(missing)).outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(tasks.getTask(actor, missing.id), missing);
  const target = await trigger('Update only the source');
  assert.ok(db.prepare(`SELECT 1 FROM ${protection[0]} WHERE source_id=?${protection[1]}`).get(target.id));
  const lookupBefore = tasks.listTasks(actor, lookup), sourceCount = tasks.listTasks(actor, source).length;
  const referenceBefore = reference && tasks.getTask(actor, reference.id);
  const result = await settle(target);
  assert.equal(result.outcome.classification, 'UNCERTAIN');
  assert.deepEqual(result.receipt, { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: target.id } });
  assert.deepEqual(result.observation.updated, { id: target.id,
    before: { priority: 'low', dueAt, tags: ['intake'] }, after: { priority: 'high', dueAt: null, tags: ['intake', 'ready'] } });
  assert.equal(tasks.listTasks(actor, source).length, sourceCount);
  assert.deepEqual(tasks.listTasks(actor, lookup), lookupBefore);
  if (exact) assert.deepEqual(tasks.getTask(actor, reference.id), referenceBefore);
  assert.equal(writes, 1);
  tasks.editTask(actor, target.id, { priority: 'normal' });
  db.close(); db = null; open();
  const rechecked = read(target, true);
  assert.equal(rechecked.originalKey, result.originalKey);
  assert.deepEqual(rechecked.reconciliation.receipt, result.receipt);
  assert.deepEqual(rechecked.reconciliation.observation, result.observation);
  assert.equal(await shared.run(result.eventId), false);
  assert.equal(tasks.getTask(actor, target.id).priority, 'normal');
  assert.equal(writes, 1);
  await assert.rejects(compileTaskBundle(compiler, 'TEAM', source, offer, () => {}, undefined, COMPOSED_MANIFEST), { status: 503 });
});

for (const harness of [EXACT_CREATED_CHECK, EXACT_COMPLETED_CHECK, OWNED_GUARD_CHECK])
test(`Personal ${harness}: exact read authority and decisive facts hold at native commit`, async t => {
  const db = openData(':memory:'), actor = 'maya', permit = () => actor;
  const lifecycle = createLifecycle(db, { compiler });
  const nativeGuard = createTaskCreateGuard({ db, lifecycle, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
  let beforeWrite;
  const guard = { ...nativeGuard, async check(input) {
    const result = await nativeGuard.check(input);
    beforeWrite?.();
    return result;
  } };
  const shared = createSharedCompletion({ db, lifecycle, guard, clock: () => 0, beforeWrite: () => beforeWrite?.() });
  const tasks = taskService(db, { guard, sharedCompletion: shared });
  t.after(async () => { await nativeGuard.close(); db.close(); });
  const project = name => tasks.createProject(actor, { name }).id;
  const source = project('Intake'), referenceProject = project('Reference'), lookup = project('Index');
  const make = (projectId, title, priority = 'normal', tags = []) => tasks.createTask(actor,
    { projectId, title, priority, tags }, { operationId: randomUUID() });
  const reference = await make(referenceProject, 'Exact reference');
  await make(referenceProject, reference.title, 'high');
  const lookupTask = await make(lookup, ownedUpdateTitle.toLowerCase());
  await make(source, ownedUpdateTitle); // A hit in the candidate project is not a hit in Index.
  const definition = sharedHost('PERSONAL', harness), hook = definition.pins.hook;
  const model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const offer = exactReadOffer(source, { id: reference.id, projectId: referenceProject, title: reference.title }, model, hook, lookup);
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const selection = lifecycle.bundleSelection(actor)[hook];
  const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0,
    selections: { [hook]: selection }, offer, format: COMPOSED_MANIFEST }, permit);
  assert.equal(proof.eligible, true);
  const exact = { extensionId, ...proof };
  lifecycle.approve(actor, exact, permit);
  lifecycle.activateTaskBundle(actor, { ...exact, generations: { [hook]: selection.generation } }, permit);
  const priority = value => tasks.editTask(actor, reference.id, { priority: value });
  const lookupTitle = title => tasks.editTask(actor, lookupTask.id, { title, notes: '' });
  const mode = value => db.prepare('UPDATE projects SET mode=? WHERE id=?').run(value, referenceProject);
  const makeSource = title => make(source, title, 'low', ['intake']);
  if (hook === 'TaskBeforeCreate') {
    const count = () => tasks.listTasks(actor, source).length;
    let before = count();
    assert.equal((await makeSource('Distractor alone allows save')).status, 'open');
    assert.equal(count(), ++before);
    priority('high');
    assert.equal((await makeSource('Other project and case still matter')).status, 'open');
    assert.equal(count(), ++before);
    lookupTitle(ownedUpdateTitle);
    await assert.rejects(makeSource('Exact read and lookup block save'), { code: 'RULE_DENIED' });
    assert.equal(count(), before);
    priority('normal');
    beforeWrite = () => priority('high');
    await assert.rejects(makeSource('Read changed before insertion'), { code: 'CHECK_UNAVAILABLE' });
    assert.equal(count(), before);
    beforeWrite = () => lookupTitle(ownedUpdateTitle);
    priority('high');
    lookupTitle(ownedUpdateTitle.toLowerCase());
    await assert.rejects(makeSource('Lookup changed before insertion'), { code: 'CHECK_UNAVAILABLE' });
    assert.equal(count(), before);
    beforeWrite = undefined;
    mode('TEAM');
    await assert.rejects(makeSource('Reference inaccessible'), { code: 'CHECK_UNAVAILABLE' });
    assert.equal(count(), before);
  } else {
    const settle = async title => {
      let task = await makeSource(title);
      if (hook === 'TaskCompleted') task = await tasks.completeTask(actor, task.id);
      const { eventId } = shared.reaction(actor, task.id, false, hook);
      assert.equal(await shared.run(eventId), true);
      return { task, result: shared.reaction(actor, task.id, false, hook) };
    };
    assert.equal((await settle('Same-title distractor does not apply')).result.outcome.result.status, 'NO_OP');
    priority('high');
    beforeWrite = () => priority('low');
    const changed = await settle('Reference changes before write');
    assert.equal(changed.result.outcome.error.code, 'ACCESS_DENIED');
    assert.equal(changed.result.receipt, null);
    assert.deepEqual(tasks.getTask(actor, changed.task.id), changed.task);
    beforeWrite = undefined;
    mode('TEAM');
    const denied = await settle('Reference is out of scope');
    assert.equal(denied.result.outcome.classification, 'BUSINESS_REJECTION');
    assert.equal(denied.result.receipt, null);
    mode('PERSONAL'); priority('high');
    const { task, result } = await settle('Exact task has high priority');
    assert.deepEqual(result.receipt, { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: task.id } });
    assert.deepEqual(result.observation.updated.after, { priority: 'high', dueAt: null, tags: ['intake', 'ready'] });
    assert.equal(tasks.getTask(actor, reference.id).priority, 'high');
  }
});

for (const hook of ['TaskCreated', 'TaskCompleted']) test(`Personal ${hook}: exact reference plus owned create keeps one destination receipt`, async t => {
  const actor = 'maya', permit = () => actor;
  const dir = mkdtempSync(join(tmpdir(), 'daymark-exact-create-')), path = join(dir, 'app.sqlite');
  let db, lifecycle, guard, shared, tasks, beforeWrite, writes = 0;
  function open() {
    db = openData(path);
    lifecycle = createLifecycle(db, { compiler });
    guard = createTaskCreateGuard({ db, lifecycle, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
    shared = createSharedCompletion({ db, lifecycle, guard, clock: () => 0, beforeWrite: () => beforeWrite?.(),
      writeReply() { writes++; throw new Error('Synthetic lost create reply'); } });
    tasks = taskService(db, { guard, sharedCompletion: shared });
  }
  async function close() { await guard.close(); db.close(); db = null; }
  t.after(async () => { if (db) await close(); rmSync(dir, { recursive: true, force: true }); });
  open();
  const project = name => tasks.createProject(actor, { name }).id;
  const source = project('Intake'), destination = project('Ledger'), lookup = project('Index'), referenceProject = project('Reference');
  const make = (projectId, title, priority = 'normal') => tasks.createTask(actor, { projectId, title, priority }, { operationId: randomUUID() });
  const reference = await make(referenceProject, 'Exact reference');
  await make(referenceProject, reference.title, 'high');
  const indexTask = await make(lookup, ownedProjectTitle.toLowerCase());
  await make(source, ownedProjectTitle);
  const definition = ownedProjectDefinition(hook, '4');
  const model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const referenceInput = { id: reference.id, projectId: referenceProject, title: reference.title };
  const offer = exactCreateOffer(model, hook, source, destination, referenceInput, lookup);
  const guardModel = sharedHost('PERSONAL', GUARD_CHECK), { domain } = JSON.parse(guardModel.dcmBytes);
  const blockedTitle = 'Hold ledger';
  offer.bindings.TaskBeforeCreate = JSON.stringify({ language: 'keir/3', name: 'destination-check',
    domain: { ...domain, fingerprint: guardModel.pins.modelDigest }, entrypoint: 'TaskBeforeCreate',
    steps: [{ id: 'marker', call: 'tasks.openMatch', args: { projectId: { cel: 'input.projectId' }, title: { literal: blockedTitle } } },
      { id: 'block', let: { cel: 'marker.matches' } }],
    return: { record: { decision: { cel: 'block ? "DENY" : "ALLOW"' }, message: { cel: 'block ? "Ledger is on hold." : ""' } } },
  });
  const guardCase = { projectId: destination, priority: 'normal', tags: [], hasDueDate: false, hasNotes: true };
  offer.cases.TaskBeforeCreate = [
    { ...guardCase, id: 'allowed', openTitles: [], expect: { decision: 'ALLOW', message: '' } },
    { ...guardCase, id: 'denied', openTitles: [blockedTitle], expect: { decision: 'DENY', message: 'Ledger is on hold.' } },
  ];
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const selection = lifecycle.bundleSelection(actor), selections = { [hook]: selection[hook], TaskBeforeCreate: selection.TaskBeforeCreate };
  const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0, selections,
    offer, format: COMPOSED_MANIFEST }, permit);
  assert.equal(proof.eligible, true);
  lifecycle.approve(actor, { extensionId, ...proof }, permit);
  lifecycle.activateTaskBundle(actor, { extensionId, ...proof,
    generations: Object.fromEntries(Object.entries(selections).map(([hook, slot]) => [hook, slot.generation])) }, permit);
  const read = (task, reconcile = false) => shared.reaction(actor, task.id, reconcile, hook);
  const trigger = async title => {
    const pending = await make(source, title);
    return hook === 'TaskCompleted' ? tasks.completeTask(actor, pending.id) : pending;
  };
  const settle = async title => {
    const task = await trigger(title);
    assert.equal(await shared.run(read(task).eventId), true);
    assert.deepEqual(tasks.getTask(actor, task.id), task);
    return { task, result: read(task) };
  };
  const priority = value => tasks.editTask(actor, reference.id, { priority: value });
  const indexTitle = title => tasks.editTask(actor, indexTask.id, { title, notes: '' });
  assert.equal((await settle('Same-title distractor')).result.outcome.result.status, 'NO_OP');
  priority('high');
  indexTitle(ownedProjectTitle);
  assert.equal((await settle('Exact index title')).result.outcome.result.status, 'NO_OP');
  indexTitle(ownedProjectTitle.toLowerCase());
  beforeWrite = () => priority('normal');
  assert.equal((await settle('Reference changes before commit')).result.receipt, null);
  priority('high');
  beforeWrite = () => indexTitle(ownedProjectTitle);
  assert.equal((await settle('Lookup changes before commit')).result.receipt, null);
  beforeWrite = undefined;
  indexTitle(ownedProjectTitle.toLowerCase());
  const setMode = value => db.prepare('UPDATE projects SET mode=? WHERE id=?').run(value, referenceProject);
  setMode('TEAM');
  assert.equal((await settle('Reference no longer available')).result.receipt, null);
  setMode('PERSONAL');
  const marker = await make(destination, blockedTitle);
  const denied = await settle('Destination guard denies');
  assert.equal(denied.result.outcome.error.code, 'TASK_INVALID');
  assert.equal(denied.result.receipt, null);
  assert.deepEqual(tasks.listTasks(actor, destination).map(task => task.id), [marker.id]);
  assert.equal(writes, 0);
  tasks.editTask(actor, marker.id, { title: 'Hold cleared', notes: '' });
  const { task, result } = await settle('Create the packet');
  assert.equal(result.outcome.classification, 'UNCERTAIN');
  assert.equal(result.receipt.effect, 'CONFIRMED');
  assert.equal(result.destinationProjectId, destination);
  const child = tasks.getTask(actor, result.receipt.value.id);
  assert.deepEqual([child.projectId, child.title], [destination, ownedProjectTitle]);
  const placement = db.prepare('SELECT parent_task_id,assignee_id FROM tasks WHERE id=?').get(child.id);
  assert.deepEqual([placement.parent_task_id, placement.assignee_id], [null, null]);
  assert.equal(shared.reaction(actor, child.id, false, 'TaskCreated'), null);
  await tasks.completeTask(actor, child.id);
  assert.equal(shared.reaction(actor, child.id), null);
  assert.equal(db.prepare("SELECT state FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(child.id).state, 'NO_BINDING');
  await close(); open();
  const recovered = read(task, true);
  assert.equal(recovered.originalKey, result.originalKey);
  assert.deepEqual(recovered.reconciliation.receipt, result.receipt);
  assert.equal(recovered.reconciliation.destinationProjectId, destination);
  assert.equal(await shared.run(result.eventId), false);
  assert.equal(writes, 1);
  const noLookup = exactCreateOffer(model, hook, source, destination, referenceInput);
  await assert.rejects(compileTaskBundle(compiler, 'TEAM', source, noLookup, () => {}, undefined, COMPOSED_MANIFEST), { status: 503 });
  const standalone = await compileTaskBundle(compiler, 'PERSONAL', actor, noLookup, () => {}, undefined, COMPOSED_MANIFEST);
  assert.equal((await checkTaskBundle(standalone, 'no-lookup', actor, [], () => {})).eligible, true);
});

test('Personal generated task can enter the retained standalone completion dispatcher exactly once', async t => {
  const db = openData(':memory:'), actor = 'maya', permit = () => actor;
  const lifecycle = createLifecycle(db, { compiler });
  const shared = createSharedCompletion({ db, lifecycle });
  const tasks = taskService(db, { sharedCompletion: shared });
  const dispatcher = createTaskDispatcher({ db, lifecycle, clock: () => 0 });
  t.after(async () => { await dispatcher.close(); db.close(); });
  const projectId = tasks.listProjects(actor).find(project => project.mode === 'PERSONAL').id;
  const otherProjectId = tasks.createProject(actor, { name: 'Other Personal project' }).id;
  const definition = ownedProjectDefinition('TaskCreated'), model = { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest };
  const offer = ownedProjectOffer(model, 'TaskCreated', projectId, projectId);
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const selection = lifecycle.bundleSelection(actor).TaskCreated;
  const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0,
    selections: { TaskCreated: selection }, offer, format: COMPOSED_MANIFEST }, permit);
  assert.equal(proof.eligible, true);
  lifecycle.approve(actor, { extensionId, ...proof }, permit);
  lifecycle.activateTaskBundle(actor, { extensionId, ...proof, generations: { TaskCreated: selection.generation } }, permit);
  const root = await tasks.createTask(actor, { projectId, title: 'Generate once', tags: ['invoices'] }, { operationId: randomUUID() });
  assert.equal(await shared.run(shared.reaction(actor, root.id, false, 'TaskCreated').eventId), true);
  const original = shared.reaction(actor, root.id, false, 'TaskCreated'), child = original.receipt.value.id;
  const events = () => db.prepare('SELECT * FROM task_events WHERE source_task_id=?').all(child);
  assert.deepEqual(events(), []);

  const { extensionId: retainedId } = admitTaskDraft(db, lifecycle, { owner: actor });
  const { source, cases } = taskCustomizationFixture({ projectId, otherProjectId });
  const compiled = await lifecycle.compile(actor, { extensionId: retainedId, hookId: TASK_HOOK, source, draftVersion: 0 }, permit);
  const prepared = await lifecycle.proposeScenarios(actor, { extensionId: retainedId, revisionId: compiled.revisionId,
    draftVersion: compiled.draftVersion, cases }, permit);
  const retainedInput = { extensionId: retainedId, revisionId: prepared.revisionId, draftVersion: prepared.draftVersion };
  const checked = await lifecycle.simulate(actor, retainedInput, permit);
  assert.equal(checked.evidence.passed, true);
  const approved = lifecycle.approve(actor, { ...retainedInput, evidenceId: checked.evidence.id }, permit);
  const active = lifecycle.activate(actor, { ...retainedInput, evidenceId: checked.evidence.id, generation: approved.selection.generation }, permit);
  assert.throws(() => tasks.completeTask(actor, child, { authorize: () => 'leo' }), { status: 401 });
  assert.deepEqual(events(), []);
  await tasks.completeTask(actor, child, { authorize: permit });
  const [admitted] = events();
  assert.equal(admitted.revision_id, retainedInput.revisionId);
  assert.equal(admitted.item_id, retainedId);
  assert.equal(admitted.selection_generation, active.selection.generation);
  assert.notEqual(admitted.original_key, original.originalKey);
  await dispatcher.wake();
  const result = dispatcher.status(actor, child);
  assert.equal(result.receipt.effect, 'CONFIRMED');
  assert.equal(taskEffectService(db).status(actor, admitted.event_id).originalKey, admitted.original_key);
  assert.deepEqual(dispatcher.reconcile(actor, child).reconciliation.receipt, result.receipt);
  assert.equal(db.prepare('SELECT count(*) n FROM task_events WHERE source_task_id=?').get(result.receipt.value.id).n, 0);
  await tasks.completeTask(actor, child);
  await dispatcher.wake();
  assert.equal(events().length, 1);
  assert.deepEqual(dispatcher.status(actor, child).receipt, result.receipt);
  assert.deepEqual(shared.reaction(actor, root.id, false, 'TaskCreated'), original);
});

test('Team completion update checks omitted fields and yields to a member edit at the native commit boundary', async t => {
  const db = openData(':memory:'), admin = 'maya', actor = 'leo', permit = () => admin;
  const capability = createTeamCapability(db, { compiler });
  let editedTask;
  const shared = createSharedCompletion({ db, teamCapability: capability, clock: () => 0,
    beforeWrite({ eventId }) {
      if (shared.reaction(actor, editedTask.id).eventId === eventId) tasks.editTask(actor, editedTask.id, { dueAt: null });
    } });
  const team = createTeamRuntime({ db, sharedCompletion: shared }), tasks = taskService(db, { team, sharedCompletion: shared });
  t.after(async () => { await team.close(); await capability.close(); db.close(); });
  const projectId = tasks.createProject(admin, { name: 'Intake', mode: 'TEAM' }).id;
  teamProjectService(db).addMember(admin, projectId, { userId: actor });
  const definition = sharedHost('TEAM', COMPLETED_UPDATE_CHECK);
  const offer = sourceUpdateOffer(projectId, { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest }, 'TaskCompleted');
  const program = JSON.parse(offer.bindings.TaskCompleted);
  delete program.steps.at(-1).args.clearDue;
  offer.bindings.TaskCompleted = JSON.stringify(program);
  const [changed, unchanged] = offer.cases.TaskCompleted;
  changed.expect.sourceAfter.dueAt = changed.sourceDueAt;
  unchanged.sourceDueAt = changed.sourceDueAt;
  const confirm = (offer, expectedDraftVersion) => capability.confirmTaskBundle(admin, projectId, {
    expectedDraftVersion, expectedSelectionGeneration: 0, offer, format: COMPOSED_MANIFEST }, permit);
  const wrong = structuredClone(offer);
  wrong.cases.TaskCompleted[0].expect.sourceAfter.dueAt = null;
  const failed = await confirm(wrong, 0);
  assert.equal(failed.eligible, false);
  const checked = await confirm(offer, 1);
  assert.equal(checked.eligible, true);
  const input = { expectedDraftVersion: 2, revisionId: checked.revisionId, evidenceId: checked.evidenceId,
    cases: capability.source(admin, projectId, checked.revisionId).sourceBundle.cases };
  const { receipt } = await capability.approve(admin, projectId, { ...input, operationId: randomUUID() }, permit);
  await capability.activate(admin, projectId, { ...input, approvalId: receipt.id,
    expectedSelectionGeneration: 0, operationId: randomUUID() }, permit);
  const make = () => tasks.createTask(actor, { projectId, title: 'Keep the due date', priority: 'low',
    tags: ['intake'], dueAt: changed.sourceDueAt }, { operationId: randomUUID() });
  editedTask = await make();
  for (const task of [editedTask, await make()]) {
    await tasks.completeTask(actor, task.id);
    const { eventId } = shared.reaction(actor, task.id);
    assert.equal(await shared.run(eventId), true);
    const { observation, outcome, receipt } = shared.reaction(actor, task.id);
    if (task === editedTask) {
      assert.equal(outcome.error.code, 'ACCESS_DENIED');
      assert.equal(receipt, null);
      const saved = tasks.getTask(actor, task.id);
      assert.deepEqual({ priority: saved.priority, tags: saved.tags, dueAt: saved.dueAt }, { priority: 'low', tags: ['intake'], dueAt: null });
    } else {
      assert.equal(receipt.effect, 'CONFIRMED');
      assert.deepEqual(observation.updated.after, { priority: 'high', tags: ['intake', 'ready'], dueAt: task.dueAt });
    }
  }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: created source update fences survive restart and stay separate from completion`, async t => {
  const actor = 'maya', permit = () => actor, teamScope = scope === 'TEAM';
  const dir = mkdtempSync(join(tmpdir(), 'daymark-created-update-')), path = join(dir, 'app.sqlite');
  let db, lifecycle, teamCapability, team, shared, tasks, beforeWrite;
  let writes = 0;
  function open() {
    db = openData(path);
    lifecycle = createLifecycle(db, { compiler });
    teamCapability = createTeamCapability(db, { compiler });
    shared = createSharedCompletion({ db, lifecycle, teamCapability, clock: () => 0,
      beforeWrite: args => beforeWrite?.(args), writeReply() { writes++; throw new Error('Synthetic lost native reply'); } });
    team = createTeamRuntime({ db, sharedCompletion: shared });
    tasks = taskService(db, { team, sharedCompletion: shared });
  }
  async function close() {
    if (!db) return;
    await team.close(); await teamCapability.close(); db.close(); db = null;
  }
  open();
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const projectId = tasks.createProject(actor, { name: 'Ferry returns', mode: scope }).id;
  if (teamScope) teamProjectService(db).addMember(actor, projectId, { userId: 'leo' });
  const creator = teamScope ? 'leo' : actor;
  const definition = sharedHost(scope, CREATED_UPDATE_CHECK);
  const offer = createdUpdateOffer(projectId, { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest });
  const completion = authored(scope, projectId);
  const program = JSON.parse(completion.bindings.TaskCompleted);
  program.steps[1].let.cel = 'source.status == "COMPLETED" && "intake" in source.tags';
  program.steps[2] = { id: 'set', call: 'tasks.update', when: 'matches', args: { priority: { literal: 'normal' } } };
  program.return.record.status.cel = 'matches ? "UPDATED" : "NO_OP"';
  offer.bindings.TaskCompleted = JSON.stringify(program);
  offer.cases.TaskCompleted = [
    { ...completion.cases.TaskCompleted[0], tags: ['intake'], priority: 'high', expect: { sourcePriority: 'normal' } },
    { ...completion.cases.TaskCompleted[1], tags: ['other'], expect: null },
  ];
  if (teamScope) {
    const proof = await teamCapability.confirmTaskBundle(actor, projectId, { expectedDraftVersion: 0,
      expectedSelectionGeneration: 0, offer, format: COMPOSED_MANIFEST }, permit);
    assert.equal(proof.eligible, true);
    const input = { expectedDraftVersion: 1, revisionId: proof.revisionId, evidenceId: proof.evidenceId,
      cases: teamCapability.source(actor, projectId, proof.revisionId).sourceBundle.cases };
    const { receipt } = await teamCapability.approve(actor, projectId, { ...input, operationId: randomUUID() }, permit);
    await teamCapability.activate(actor, projectId, { ...input, approvalId: receipt.id,
      expectedSelectionGeneration: 0, operationId: randomUUID() }, permit);
  } else {
    const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
    const { TaskCreated, TaskCompleted } = lifecycle.bundleSelection(actor), selections = { TaskCreated, TaskCompleted };
    const proof = await lifecycle.confirmTaskBundle(actor, { extensionId, revisionId: null, draftVersion: 0, selections,
      offer, format: COMPOSED_MANIFEST }, permit);
    assert.equal(proof.eligible, true);
    const input = { extensionId, ...proof };
    lifecycle.approve(actor, input, permit);
    lifecycle.activateTaskBundle(actor, { ...input,
      generations: Object.fromEntries(Object.entries(selections).map(([key, value]) => [key, value.generation])) }, permit);
  }
  const dueAt = '2026-12-07T07:01:02.000Z';
  const make = (title, fields) => tasks.createTask(creator,
    { projectId, title, notes: 'Keep\0everything.', priority: 'low', tags: ['intake'], dueAt, ...fields }, { operationId: randomUUID() });
  const read = (task, reconcile = false) => shared.reaction(creator, task.id, reconcile, 'TaskCreated');
  const fence = task => db.prepare('SELECT valid FROM shared_created_updates WHERE source_id=? AND event_id=?').get(task.id, read(task).eventId);
  const changed = await make('Travel refund'), unchanged = await make('Already ready', { priority: 'high', tags: ['intake', 'ready'], dueAt: null });
  const skipped = await make('Not intake', { tags: ['other'] }), late = await make('Updated before dispatch'), gone = await make('Missing protection');
  const completed = await make('Completed before dispatch'), racing = await make('Edit at write boundary');
  for (const task of [changed, unchanged, skipped, late, gone, completed, racing]) assert.equal(fence(task).valid, 1);
  db.prepare("UPDATE tasks SET priority='normal' WHERE id=?").run(late.id);
  db.prepare("UPDATE tasks SET priority='low' WHERE id=?").run(late.id);
  assert.deepEqual(tasks.getTask(creator, late.id), late); // Same timestamp and restored bytes do not re-arm.
  assert.equal(fence(late).valid, 0);
  db.prepare('DELETE FROM shared_created_updates WHERE source_id=?').run(gone.id);
  await tasks.completeTask(creator, completed.id);
  const completionEvent = shared.reaction(creator, completed.id);
  assert.equal(fence(completed).valid, 0);
  assert.notEqual(completionEvent.originalKey, read(completed).originalKey);

  await close(); open();
  beforeWrite = ({ eventId }) => {
    if (eventId === read(racing).eventId) tasks.editTask(creator, racing.id, { priority: 'normal' });
  };
  for (const task of [late, gone, racing, completed]) {
    assert.ok(await shared.run(read(task).eventId));
    assert.equal(read(task, true).receipt, null);
    assert.equal(read(task).outcome.classification, 'BUSINESS_REJECTION');
  }
  assert.deepEqual(tasks.getTask(creator, late.id), late);
  assert.deepEqual(tasks.getTask(creator, gone.id), gone);
  assert.equal(tasks.getTask(creator, racing.id).priority, 'normal');
  assert.equal(tasks.getTask(creator, completed.id).priority, 'low');
  assert.ok(await shared.run(completionEvent.eventId));
  assert.equal(tasks.getTask(creator, completed.id).priority, 'normal');
  assert.equal(shared.reaction(creator, completed.id, true).receipt.value.id, completed.id);

  for (const task of [changed, unchanged, skipped]) assert.ok(await shared.run(read(task).eventId));
  const saved = read(changed, true), settled = tasks.getTask(creator, changed.id);
  assert.deepEqual({ priority: settled.priority, tags: settled.tags, dueAt: settled.dueAt }, { priority: 'high', tags: ['intake', 'ready'], dueAt: null });
  assert.equal(settled.notes, changed.notes);
  assert.equal(saved.capability, 'tasks.update');
  assert.equal(saved.linked, false);
  assert.equal(saved.outcome.classification, 'UNCERTAIN');
  assert.equal(saved.receipt.effect, 'CONFIRMED');
  assert.equal(saved.receipt.value.id, changed.id);
  assert.deepEqual(saved.reconciliation.observation, saved.observation);
  assert.equal(shared.verifiedCreatedTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(changed.id)), false);
  assert.deepEqual(tasks.getTask(creator, unchanged.id), unchanged);
  assert.deepEqual(read(unchanged).observation.updated.before, read(unchanged).observation.updated.after);
  assert.equal(read(skipped).outcome.result.status, 'NO_OP');
  assert.equal(read(skipped).receipt, null);
  assert.equal(tasks.listTasks(creator, projectId).length, 7);
  assert.equal(writes, 3);
  await close(); open();
  for (const task of [changed, unchanged, skipped, late, gone, completed]) assert.equal(await shared.run(read(task).eventId), false);
  assert.deepEqual(read(changed).receipt, saved.receipt);
  assert.deepEqual(read(changed).observation, saved.observation);
  assert.equal(writes, 3);
});

for (const version of [21, 22, 23]) test(`populated v${version} keeps event and selection bytes through rollback and upgrades additively`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-upgrade-')), path = join(dir, 'app.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = openData(path);
  const snapshot = db => ['tasks', 'task_events', 'team_admissions', 'extension_selections', ...(version >= 22
    ? [...sharedBundleTables, 'extension_authored', 'extension_evidence'] : []), ...(version === 23 ? [sharedPersonalAdmissionTable] : [])].map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const tasks = taskService(db);
  let legacy;
  for (const mode of ['PERSONAL', 'TEAM']) {
    const projectId = tasks.createProject('maya', { name: 'Existing tasks', mode }).id;
    await tasks.createTask('maya', { title: 'Keep exactly', projectId }, { operationId: randomUUID() });
     if (version >= 22 && mode === 'PERSONAL') {
      const lifecycle = createLifecycle(db, { compiler }), capability = createTeamCapability(db);
      const guard = createTaskCreateGuard({ db, lifecycle, sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
      try {
        const { extensionId } = admitTaskDraft(db, lifecycle, { owner: 'maya' }), permit = () => 'maya';
        const selections = lifecycle.bundleSelection('maya'), offer = authored(mode, projectId, ' old');
        const proof = await lifecycle.confirmTaskBundle('maya', { extensionId, revisionId: null, draftVersion: 0, selections, offer }, permit);
        const input = { extensionId, ...proof };
        lifecycle.approve('maya', input, permit);
        lifecycle.activateTaskBundle('maya', { ...input, generations: Object.fromEntries(Object.entries(selections).map(([h, s]) => [h, s.generation])) }, permit);
        const shared = createSharedCompletion({ db, lifecycle, teamCapability: capability, guard, clock: () => 0 });
        const task = await taskService(db, { guard, sharedCompletion: shared }).createTask('maya',
          { projectId, title: 'Saved with v1', notes: 'Filed.', tags: ['receipt'] }, { operationId: randomUUID() });
        const event = shared.reaction('maya', task.id, false, 'TaskCreated');
        await shared.run(event.eventId);
        legacy = { input, task, result: shared.reaction('maya', task.id, true, 'TaskCreated') };
        assert.equal(legacy.result.receipt.effect, 'CONFIRMED');
      } finally { await guard.close(); await capability.close(); }
    }
  }
  const before = snapshot(db);
  db.exec(`DROP TRIGGER shared_created_update_personal; DROP TRIGGER shared_created_update_team; DROP TRIGGER shared_created_update_edit;
    ${['shared_created_updates', ...(version < 23 ? [sharedPersonalAdmissionTable] : []), ...(version === 21 ? sharedBundleTables : [])]
      .map(table => 'DROP TABLE ' + table).join(';')}; PRAGMA user_version=${version}`);
  db.close();
  const bytes = readFileSync(path);
  assert.throws(() => openData(path, { allowUpgrade: false }), /Unsupported database version/);
  assert.deepEqual(readFileSync(path), bytes);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'PRAGMA user_version=24') throw new Error('Bundle migration interrupted');
    return exec.call(this, sql);
  };
  try { assert.throws(() => openData(path), /Bundle migration interrupted/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(readFileSync(path), bytes);
  db = openData(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${sharedPersonalAdmissionTable}`).get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_created_updates').get().n, 0);
    if (version === 21) for (const table of sharedBundleTables) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  db = openData(path, { allowUpgrade: false });
  try {
    assert.deepEqual(snapshot(db), before);
    if (legacy) {
      const { input, task, result } = legacy, lifecycle = createLifecycle(db);
      const shared = createSharedCompletion({ db, lifecycle });
      assert.equal(lifecycle.evidence('maya', input.evidenceId, input.extensionId).eligible, true);
      const read = shared.reaction('maya', task.id, true, 'TaskCreated');
      assert.deepEqual({ ...read, reconciliation: { ...read.reconciliation, observedAt: result.reconciliation.observedAt } }, result);
      assert.equal(await shared.run(result.eventId), false);
    }
  } finally { db.close(); }
});
