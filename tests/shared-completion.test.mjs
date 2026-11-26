import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { definitionForPins, sharedBeforeCreateDefinition, sharedCompletionDefinition, loadHost, authoringDefinition, digest } from '../src/extension-catalog.mjs';
import { checkSharedCompletion, createSharedCompletion } from '../src/shared-completion.mjs';
import { sharedBundleTables, sharedCompletionTables, sharedPersonalAdmissionTable } from '../src/shared-completion-schema.mjs';
import { createTeamRuntime, installTeamRevision, teamModelBytes } from '../src/team-runtime.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { restoreSavedCore } from './fixtures/saved-core-0.3.0.mjs';
import { linkedProposal } from './fixtures/team-authored.mjs';
import { seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTaskCreateGuard } from '../src/task-create-guard.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { completionOffer, completionProofMatches, readCompletionManifest, scopedCompletionManifest, SHARED_CHECK, LOOKUP_CHECK, PRIORITY_CHECK, DUE_CHECK } from '../src/shared-completion-contract.mjs';
import { handoffArgs, handoffExpected } from './fixtures/shared-creation.mjs';
import { beforeCreateOffer, correction } from './fixtures/shared-before-create.mjs';

const cel = value => ({ cel: value });
const compiler = createCompiler(), artifacts = {}, sources = new Map();
async function compile(scope, change = () => {}, version) {
  const definition = sharedCompletionDefinition(scope, version), model = JSON.parse(definition.dcmBytes);
  const program = { language: 'keir/3', domain: { ...model.domain, fingerprint: definition.pins.modelDigest },
    entrypoint: 'TaskCompleted', name: 'customer-follow-up',
    steps: [
      { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
      { id: 'eligible', let: cel('source.status == "COMPLETED" && "for customer" in source.tags') },
      { id: 'created', call: 'tasks.create', when: 'eligible', args: {
        projectId: cel('source.projectId'), title: cel('source.title + " follow up"'),
        dueAt: cel('input.occurredAt + duration("604800s")'),
      } },
    ], return: { record: { status: cel('eligible ? "CREATED" : "NO_OP"') } } };
  change(program);
  const source = JSON.stringify(program), result = await compiler.compile(Buffer.from(source), { definition });
  if (result.artifact) sources.set(result.artifact, source);
  return result;
}
const collaboration = program => Object.assign(program.steps[2].args, {
  parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' },
});
async function checked(scope, change, version) {
  const result = await compile(scope, change, version);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.artifact);
  return result.artifact;
}
before(async () => {
  artifacts.personal = await checked('PERSONAL');
  artifacts.team = await checked('TEAM');
  artifacts.linked = await checked('TEAM', collaboration);
});

const occurredAt = '2026-03-07T16:00:00.417Z';
const defaults = { priority: 'normal', openTitles: [] };
const noMatch = { id: 'near-miss', title: 'Review brief', tags: ['for customers'], occurredAt, ...defaults, expect: null };
const example = linked => ({ id: 'match', title: 'Review brief', tags: ['for customer'], occurredAt, ...defaults,
  expect: { title: 'Review brief follow up', dueAt: '2026-03-14T16:00:00.417Z', linked, assigneeId: linked ? 'leo' : null,
    project: 'SAME_PROJECT', notes: '', tags: [], priority: 'normal' } });
const offerFor = (artifact, cases) => ({ bindings: { TaskBeforeComplete: null, TaskBeforeCreate: null,
  TaskCompleted: sources.get(artifact), TaskCreated: null }, cases });
const permit = () => {};
function setup(t, db = openData(':memory:'), { cleanup, compileWith = compiler, faultBinding, wrapGuard, ...options } = {}) {
  const lifecycle = createLifecycle(db, { compiler: compileWith }), capability = createTeamCapability(db, { compiler: compileWith });
  const realGuard = wrapGuard && createTaskCreateGuard({ db, lifecycle, teamCapability: capability,
    sharedPersonalBinding: lifecycle.sharedBeforeCreateBinding, commitReserveMs: 100 });
  const guard = wrapGuard ? wrapGuard(realGuard) : options.guard;
  // Fault bindings are test-only, after the real authority check for the captured revision.
  const shared = createSharedCompletion({ db, lifecycle: { sharedCompletionBinding: row => {
    const original = lifecycle.sharedCompletionBinding(row);
    return faultBinding?.() ?? original;
  } }, teamCapability: { sharedCompletionBinding: (...args) => {
    const original = capability.sharedCompletionBinding(...args);
    return faultBinding?.() ?? original;
   } }, ...options, guard });
  const team = createTeamRuntime({ db, sharedCompletion: shared });
  const tasks = taskService(db, { team, sharedCompletion: shared, ...(wrapGuard && { guard }) }), project = (name, mode, owner = 'maya') => tasks.createProject(owner, { name, mode }).id;
  const create = (actor, projectId, title, tags = ['for customer']) => tasks.createTask(actor, { projectId, title, tags }, { operationId: randomUUID() });
  const event = task => db.prepare('SELECT * FROM shared_completion_events WHERE source_id=?').get(task.id);
  const projects = teamProjectService(db);
  t.after(async () => { await team.close(); await realGuard?.close(); await capability.close(); db.close(); await cleanup?.(); });
  async function activate(actor, artifact, projectId, cases = [example(artifact === artifacts.linked), noMatch], { confirmOnly = false, keepSlot = false } = {}) {
    let result, input, approvals;
    const offer = offerFor(artifact, cases);
    if (projectId) {
      let state = capability.state(actor, projectId);
      if (state.selection.revisionId && !keepSlot) {
        await capability.deactivate(actor, projectId, { operationId: randomUUID(), targetRevisionId: state.selection.revisionId,
          expectedSelectionRevisionId: state.selection.revisionId, expectedSelectionGeneration: state.selection.generation });
        state = capability.state(actor, projectId);
      }
      result = await capability.confirmSharedCompletion(actor, projectId, { expectedDraftVersion: state.draftVersion,
        expectedSelectionGeneration: state.selection.generation, offer });
      input = { operationId: randomUUID(), expectedDraftVersion: result.draftVersion, revisionId: result.revisionId, evidenceId: result.evidenceId, cases };
      if (confirmOnly) return { result, input, generation: state.selection.generation };
      assert.equal(result.eligible, true, JSON.stringify(capability.evidence(actor, projectId, result.evidenceId)));
      approvals = await capability.approve(actor, projectId, input);
      await capability.activate(actor, projectId, { ...input, operationId: randomUUID(), approvalId: approvals.receipt.id,
        expectedSelectionGeneration: state.selection.generation });
    } else {
      const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor, name: 'Internal completion' });
      const state = lifecycle.state(actor, extensionId);
      result = await lifecycle.confirmSharedCompletion(actor, { extensionId, revisionId: null, draftVersion: 0,
        generation: state.selection.generation, offer }, permit);
      input = { extensionId, ...result, generation: state.selection.generation };
      if (confirmOnly) return { result, input };
      assert.equal(result.eligible, true, JSON.stringify(lifecycle.evidence(actor, result.evidenceId, extensionId)));
      lifecycle.approve(actor, input, permit);
      lifecycle.activate(actor, input, permit);
    }
    return result.revisionId;
  }
  return { db, shared, team, tasks, project, create, event, projects, lifecycle, capability, activate };
}
const due = task => new Date(Date.parse(task.completedAt) + 604800000).toISOString();

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: shared before-create admission and generated policy boundaries`, async t => {
  const isTeam = scope === 'TEAM', actor = isTeam ? 'leo' : 'maya';
  let afterCheck;
  const f = setup(t, undefined, { wrapGuard: guard => ({
    ...guard, async check(input) {
      const decision = await guard.check(input);
      await afterCheck?.(decision);
      return decision;
    },
  }) });
  const { db, tasks, lifecycle, capability, projects, create, shared, event, team } = f;
  const model = sharedBeforeCreateDefinition(scope);
  const offer = (project, message) => beforeCreateOffer({ ...JSON.parse(model.dcmBytes), fingerprint: model.pins.modelDigest }, project, message);
  const producer = await checked(scope, p => { delete p.steps[2].args.dueAt; });
  const producerCase = example(false);
  producerCase.expect.dueAt = null;
  const legacySource = isTeam && linkedProposal().bindings;
  const legacy = isTeam && Object.fromEntries(await Promise.all(Object.entries(legacySource).map(async ([hook, source]) => {
    const result = await createCompiler({ modelBytes: teamModelBytes }).compile(Buffer.from(source));
    assert.deepEqual(result.diagnostics, []);
    return [hook, result.artifact];
  })));
  for (const old of isTeam ? ['shared', 'legacy'] : ['shared']) {
    const projectId = f.project(`Intake ${old}`, scope);
    if (isTeam) projects.addMember('maya', projectId, { userId: actor });
    const unbound = await create(actor, projectId, 'Before policy');
    const pin = old === 'legacy' ? 'legacy-intake' : await f.activate('maya', producer, isTeam ? projectId : undefined, [producerCase, noMatch]);
    if (old === 'legacy') {
      installTeamRevision(db, 'maya', projectId, pin, legacy);
      projects.setSelection('maya', projectId, pin);
    }
    const parent = await create(actor, projectId, 'Pinned work'), readPin = task =>
      db.prepare('SELECT revision_id,policy_state,manifest FROM team_admissions WHERE source_task_id=?').get(task.id);
    const secondParent = isTeam && await create(actor, projectId, 'Pinned work to revoke');
    const oldPin = isTeam && readPin(parent);
    const { extensionId } = isTeam ? {} : admitTaskDraft(db, lifecycle, { owner: actor, name: 'Intake check' });
    const confirm = async input => {
      const state = isTeam ? capability.state('maya', projectId) : lifecycle.state(actor, extensionId);
      const generation = isTeam ? state.selection.generation : db.prepare("SELECT generation FROM extension_selections WHERE owner_id=? AND hook_id='TaskBeforeCreate'").get(actor).generation;
      const result = isTeam ? await capability.confirmSharedCompletion('maya', projectId,
        { expectedDraftVersion: state.draftVersion, expectedSelectionGeneration: generation, offer: input })
        : await lifecycle.confirmSharedCompletion(actor, { extensionId, revisionId: state.draft?.id ?? null,
          draftVersion: state.draftVersion, generation, offer: input }, permit);
      const { revisionId, evidenceId, draftVersion } = result;
      return { result, args: { revisionId, evidenceId, ...(isTeam ? { expectedDraftVersion: draftVersion, cases: input.cases }
        : { extensionId, draftVersion, generation }) }, generation };
    };
    const approval = ({ args }) => isTeam ? capability.approve('maya', projectId, { ...args, operationId: randomUUID() })
      : lifecycle.approve(actor, args, permit);
    const turnOn = ({ args }, approved, generation) => isTeam ? capability.activate('maya', projectId, {
      ...args, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: generation,
    }) : lifecycle.activate(actor, { ...args, generation }, permit);
    if (old === 'shared') {
      const wrong = await confirm(offer(projectId, 'Wrong correction.'));
      assert.equal(wrong.result.passed, false);
      await assert.rejects(async () => approval(wrong), { status: 409 });
    }
    const draft = await confirm(offer(projectId));
    assert.equal(draft.result.eligible, true);
    if (isTeam) await assert.rejects(capability.approve(actor, projectId, { ...draft.args, operationId: randomUUID() }), { status: 403 });
    const approved = await approval(draft);
    const stop = () => {
      const selection = capability.state('maya', projectId).selection;
      return capability.deactivate('maya', projectId, { operationId: randomUUID(), targetRevisionId: selection.revisionId,
        expectedSelectionRevisionId: selection.revisionId, expectedSelectionGeneration: selection.generation });
    };
    if (isTeam) {
      await assert.rejects(turnOn(draft, approved, draft.generation), { status: 409 });
      await stop();
    }
    const generation = isTeam ? capability.state('maya', projectId).selection.generation : draft.generation;
    await turnOn(draft, approved, generation);
    const fields = { projectId, title: 'New intake', notes: ' \u00a0 ', tags: [' Intake '] };
    const native = (overrides, operationId = randomUUID()) => tasks.createTask(actor, { ...fields, ...overrides },
      { operationId, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } });
    const count = () => ['tasks', 'team_admissions', 'task_events'].map(table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    const counts = count(), key = randomUUID();
    await assert.rejects(native({}, key), { status: 422, code: 'RULE_DENIED', message: correction });
    assert.deepEqual(count(), counts);
    assert.deepEqual(tasks.getCreateOperation(actor, key), { operationId: key, state: 'NOT_CREATED', code: 'RULE_DENIED', message: correction });
    await assert.rejects(native({ notes: 'fixed' }, key), { code: 'CREATE_PAYLOAD_MISMATCH' });
    const allowed = await native({ notes: 'Intake recorded.' });
    assert.deepEqual(allowed.tags, ['intake']);
    if (isTeam) {
      assert.equal(readPin(allowed).revision_id, draft.result.revisionId);
      assert.equal(readPin(allowed).policy_state, 'PINNED');
      await assert.rejects(tasks.createTask('sam', fields, { operationId: randomUUID() }), { status: 404 });
      await tasks.completeTask(actor, unbound.id);
      assert.equal(readPin(unbound).policy_state, 'NO_POLICY');
      assert.equal(event(unbound), undefined);
      if (old === 'shared') {
        afterCheck = async () => {
          await stop();
          await turnOn(draft, approved, capability.state('maya', projectId).selection.generation);
        };
        await assert.rejects(native({ notes: 'Allowed but stale' }), { status: 409, code: 'STALE_ATTEMPT' });
        afterCheck = () => db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, actor);
        const before = count();
        await assert.rejects(native({ notes: 'Membership removed' }), { status: 404 });
        assert.deepEqual(count(), before);
        afterCheck = null;
        projects.addMember('maya', projectId, { userId: actor });
      }
      assert.deepEqual(readPin(parent), oldPin);
    }
    if (old === 'legacy') {
      await team.wake();
      const childId = db.prepare('SELECT child_id FROM team_admissions WHERE source_task_id=?').get(parent.id).child_id;
      assert.ok(childId);
      assert.equal(readPin({ id: childId }), undefined);
      await assert.rejects(tasks.completeTask(actor, parent.id), { status: 422 });
      await tasks.completeTask(actor, childId);
      await tasks.completeTask(actor, parent.id);
    } else {
      await tasks.completeTask(actor, parent.id);
      assert.equal(await shared.run(event(parent).id), true);
      const result = shared.status(actor, parent.id);
      if (isTeam) {
        assert.equal(result.receipt.effect, 'CONFIRMED');
        assert.equal(readPin({ id: result.receipt.value.id }), undefined);
        assert.equal(event({ id: result.receipt.value.id }), undefined);
      } else {
        assert.equal(result.outcome.error.code, 'TASK_INVALID');
        assert.equal(result.receipt, null);
      }
    }
    if (isTeam) {
      const revoke = targetRevisionId => {
        const selection = capability.state('maya', projectId).selection;
        return capability.revoke('maya', projectId, { operationId: randomUUID(), targetRevisionId,
          expectedSelectionRevisionId: selection.revisionId, expectedSelectionGeneration: selection.generation });
      };
      await revoke(pin);
      await assert.rejects(tasks.completeTask(actor, secondParent.id), { status: 503 });
      assert.equal(event(secondParent), undefined);
      const before = count();
      const proof = db.prepare('SELECT * FROM team_evidence WHERE id=?').get(draft.result.evidenceId);
      db.exec('PRAGMA foreign_keys=OFF'); // Fault injection in the disposable database only.
      try {
        db.prepare('DELETE FROM team_evidence WHERE id=?').run(proof.id);
        await assert.rejects(native({ notes: 'No exact proof' }), { status: 503, code: 'CHECK_UNAVAILABLE' });
      } finally {
        db.prepare(`INSERT INTO team_evidence(id,project_id,revision_id,executable_identity,case_digest,harness,cases,report,passed,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(proof));
        db.exec('PRAGMA foreign_keys=ON');
      }
      assert.deepEqual(count(), before);
      assert.equal((await tasks.completeTask(actor, allowed.id)).status, 'completed');
      assert.equal(event(allowed), undefined);
      await revoke(draft.result.revisionId);
    }
    if (old === 'shared') {
      const title = 'Intake  in progress', lookup = offer(projectId);
      const program = JSON.parse(lookup.bindings.TaskBeforeCreate);
      program.steps.unshift({ id: 'existing', call: 'tasks.openMatch', args: { projectId: cel('input.projectId'), title: { literal: title } } });
      program.steps[1].let.cel += ' && existing.matches';
      lookup.bindings.TaskBeforeCreate = JSON.stringify(program);
      lookup.cases[0].openTitles = [title];
      lookup.cases[1].hasNotes = false;
      if (!isTeam) lifecycle.disable(actor, { extensionId, generation: generation + 1 }, permit);
      const proof = await confirm(lookup);
      assert.equal(proof.result.eligible, true);
      await turnOn(proof, await approval(proof), proof.generation);
      await native({ title: 'Intake in progress' }); // Near title does not count.
      afterCheck = async decision => {
        assert.equal(decision.status, 'ALLOWED');
        afterCheck = null;
        await native({ title, notes: 'Existing work.' });
      };
      const key = randomUUID();
      await assert.rejects(native({ title: 'Now stale' }, key), { status: 503, code: 'CHECK_UNAVAILABLE' });
      assert.equal(tasks.getCreateOperation(actor, key).state, 'NOT_CREATED');
      await assert.rejects(native({ title: 'Denied after lookup' }), { status: 422, message: correction });
    }
  }
});

test('pinned compiler accepts common parity and Team composition; absent capabilities and wrong model are rejected', async () => {
  const p = sharedCompletionDefinition('PERSONAL'), t = sharedCompletionDefinition('TEAM');
  assert.notEqual(p.pins.modelDigest, t.pins.modelDigest);
  assert.deepEqual(definitionForPins(t.pins).dcmBytes, t.dcmBytes);
  assert.throws(() => definitionForPins({ ...t.pins, modelDigest: p.pins.modelDigest }), /mismatch/);
  assert.notEqual(loadHost().pins.modelDigest, p.pins.modelDigest);
  assert.throws(() => authoringDefinition('TaskCompleted', p.pins.modelDigest), /Unsupported authoring model/);
  const a = JSON.parse(p.dcmBytes), b = JSON.parse(t.dcmBytes);
  assert.deepEqual(a.capabilities['tasks.get'], b.capabilities['tasks.get']);
  const { parentTaskId, assigneeId, ...common } = b.capabilities['tasks.create'].parameters;
  assert.ok(parentTaskId.optional && assigneeId.optional);
  assert.deepEqual(a.capabilities['tasks.create'].parameters, common);
  assert.deepEqual(Object.keys(a.entrypoints), ['TaskCompleted']);
  assert.deepEqual(Object.keys(b.capabilities).sort(), ['tasks.create', 'tasks.get', 'tasks.openMatch', 'tasks.update']);
  for (const [change, scope] of [
    [collaboration, 'PERSONAL'],
    [p => { p.steps[2].call = 'tasks.update'; }, 'TEAM'],
    [p => { p.entrypoint = 'TaskCreated'; }, 'TEAM'],
    [p => { p.steps[2].args.actorId = { literal: 'maya' }; }, 'TEAM'],
  ]) {
    const result = await compile(scope, change);
    assert.equal(result.artifact, null);
    assert.ok(result.diagnostics.length);
  }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: compiler source provenance rejects a different program and preserves JSON formatting`, async t => {
  const notes = 'café 🚀\n\\n\t';
  const team = scope === 'TEAM', artifact = await checked(scope, p => {
    p.steps[2].args.notes = { literal: notes };
  }), source = sources.get(artifact);
  const changed = await checked(scope, p => { p.steps[2].args.title = { literal: 'Different task' }; });
  const formatted = JSON.stringify(JSON.parse(source), null, 2) + '\n';
  let substitute = true;
  const { db, project, lifecycle, capability } = setup(t, undefined, { compileWith: { compile: (...args) =>
    substitute ? { artifact, diagnostics: [] } : compiler.compile(...args) } });
  const projectId = project('Source identity', scope), subject = team ? projectId : 'maya';
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: 'maya' });
  const matching = example(false);
  const cases = [{ ...matching, expect: { ...matching.expect, notes } }, noMatch];
  const confirm = text => {
    const offer = offerFor(artifact, cases);
    offer.bindings.TaskCompleted = text;
    return team ? capability.confirmSharedCompletion('maya', projectId, { expectedDraftVersion: 0, expectedSelectionGeneration: 0, offer })
      : lifecycle.confirmSharedCompletion('maya', { extensionId, revisionId: null, draftVersion: 0, generation: 0, offer }, permit);
  };
  const changedSource = sources.get(changed);
  await assert.rejects(confirm(changedSource), { status: 503 });
  assert.equal(team ? capability.state('maya', projectId).draftVersion : lifecycle.state('maya', extensionId).draftVersion, 0);
  const forged = scopedCompletionManifest(scope, subject, source, artifact, cases);
  forged.hooks.TaskCompleted.rawSourceDigest = digest(changedSource);
  assert.throws(() => readCompletionManifest(scope, subject, forged, changedSource, artifact, cases), { status: 503 });
  await assert.rejects(confirm(source.replace('"name":', '"name":"duplicate","name":')), { status: 400 });
  substitute = false;
  const saved = await confirm(formatted);
  assert.equal(saved.eligible, true);
  const exact = team ? capability.source('maya', projectId, saved.revisionId).manifest
    : lifecycle.source('maya', saved.revisionId, extensionId).pins;
  const pins = exact.hooks.TaskCompleted;
  assert.equal(pins.rawSourceDigest, digest(formatted));
  assert.notEqual(pins.compiledSourceDigest, pins.rawSourceDigest);
  assert.equal(pins.compiledSourceDigest, JSON.parse(artifact).sourceDigest);
  assert.equal(pins.artifactDigest, digest(artifact));
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: approval follows native effect coverage, not just passing examples`, async t => {
  const team = scope === 'TEAM', artifact = team ? artifacts.team : artifacts.personal;
  const { project, lifecycle, capability, activate } = setup(t);
  const projectId = team ? project('Coverage', scope) : undefined;
  const confirm = (artifact, cases) => activate('maya', artifact, projectId, cases, { confirmOnly: true });
  const approve = ({ input }) => team ? capability.approve('maya', projectId, input) : lifecycle.approve('maya', input, permit);
  for (const cases of [[noMatch], [example(false)]]) {
    const oneBranch = await confirm(artifact, cases);
    assert.equal(oneBranch.result.passed, true);
    assert.equal(oneBranch.result.eligible, false);
    if (team) {
      assert.equal(capability.evidence('maya', projectId, oneBranch.result.evidenceId).passed, true);
      assert.equal(capability.state('maya', projectId).eligibility.eligible, false);
    } else {
      assert.deepEqual(lifecycle.state('maya', oneBranch.input.extensionId).evidence,
        { id: oneBranch.result.evidenceId, revisionId: oneBranch.result.revisionId, passed: true, eligible: false });
    }
    await assert.rejects(async () => approve(oneBranch), { status: 409 });
  }
  const unconditional = await checked(scope, p => {
    delete p.steps[2].when;
    p.steps.splice(1, 1);
    p.return.record.status = { literal: 'CREATED' };
  });
  const write = await confirm(unconditional, [example(false)]);
  assert.equal(write.result.eligible, true);
  await approve(write);
  const readOnly = await checked(scope, p => {
    p.steps.splice(1);
    p.return.record.status = { literal: 'NO_OP' };
  });
  const unsupported = await confirm(readOnly, [example(false)]);
  assert.equal(unsupported.result.eligible, false);
  await assert.rejects(async () => approve(unsupported), { status: 409 });
  const noWrite = await confirm(readOnly, [noMatch]);
  assert.equal(noWrite.result.eligible, true);
  await approve(noWrite);
  if (!team) {
    const falseClaim = await checked(scope, p => { p.steps.pop(); });
    const deceptive = await confirm(falseClaim, [noMatch]);
    assert.equal(deceptive.result.passed, true);
    assert.equal(deceptive.result.eligible, false);
    await assert.rejects(async () => approve(deceptive), { status: 409 });
  }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: complete creation proof binds native notes, tags, priority and same-project placement`, async t => {
  const team = scope === 'TEAM', f = setup(t), projectId = f.project('Dispatch work', scope);
  if (team) f.projects.addMember('maya', projectId, { userId: 'leo' });
  const program = p => {
    p.steps.splice(1, 2, { id: 'created', call: 'tasks.create', args: { projectId: cel('source.projectId'), ...handoffArgs } });
    p.steps[1].args.notes = { literal: handoffArgs.notes.literal + '\0End of instructions' };
    p.return.record.status = { literal: 'CREATED' };
    if (team) Object.assign(p.steps[1].args, { parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' } });
  };
  const artifact = await checked(scope, program);
  const expect = { ...handoffExpected, title: 'Handoff: Pack samples\0ready',
    notes: handoffExpected.notes + '\0End of instructions', linked: team, assigneeId: team ? 'leo' : null };
  const example = { id: 'handoff', title: 'Pack samples\0ready', tags: [], occurredAt, ...defaults, expect };
  const confirm = (bytes, cases) => f.activate('maya', bytes, team ? projectId : undefined, cases, { confirmOnly: true });
  const proof = ({ result, input }) => team ? f.capability.evidence('maya', projectId, result.evidenceId).report
    : f.lifecycle.evidence('maya', result.evidenceId, input.extensionId);
  const approve = ({ input }) => team ? f.capability.approve('maya', projectId, input) : f.lifecycle.approve('maya', input, permit);
  const conditionalNotes = await checked(scope, p => {
    program(p);
    p.steps[1].args.notes = cel('source.priority == "high" ? "Urgent" : "Routine"');
  });
  const partial = await confirm(conditionalNotes, [{ ...example, expect: { ...expect, notes: 'Routine' } }]);
  assert.equal(partial.result.passed, true);
  assert.equal(proof(partial).checks[0].observed.notes, 'Routine');
  assert.equal(partial.result.eligible, false);
  await assert.rejects(async () => approve(partial), { status: 409 });
  for (const [field, value] of [['notes', handoffExpected.notes + '\0Wrong suffix'], ['tags', ['handoff', 'needs review']], ['priority', 'normal']]) {
    const saved = await confirm(artifact, [{ ...example, expect: { ...expect, [field]: value } }]);
    assert.equal(saved.result.eligible, false);
    assert.equal(saved.result.passed, false);
    assert.deepEqual(proof(saved).checks[0].observed, expect);
    await assert.rejects(async () => approve(saved), { status: 409 });
  }
  const { notes, ...omitted } = expect;
  await assert.rejects(confirm(artifact, [{ ...example, expect: omitted }]), { status: 400 });
  await assert.rejects(confirm(artifact, [{ ...example, expect: { ...expect, project: 'OTHER_PROJECT' } }]), { status: 400 });
  const fixed = await checked(scope, p => {
    program(p);
    p.steps[1].args.projectId = { literal: team ? projectId : 'example-personal-project', type: 'ProjectId' };
  });
  const fixedDraft = await confirm(fixed, [example]);
  assert.equal(fixedDraft.result.eligible, false);
  await assert.rejects(async () => approve(fixedDraft), { status: 409 });
  const other = await checked(scope, p => {
    program(p);
    p.steps[1].args.projectId = { literal: 'elsewhere', type: 'ProjectId' };
  });
  const unknown = await confirm(other, [{ ...example, expect: null }]);
  assert.equal(unknown.result.passed, false);
  assert.deepEqual(proof(unknown).checks.map(({ branch, effect, observed }) => ({ branch, effect, observed })),
    [{ branch: 'UNVERIFIED', effect: 'UNVERIFIED', observed: null }]);

  const absent = await checked(scope, p => { p.steps.splice(1); p.return.record.status = { literal: 'NO_OP' }; });
  const noEffect = await confirm(absent, [{ ...example, expect: null }]);
  assert.equal(noEffect.result.eligible, true);
  assert.deepEqual(proof(noEffect).checks.map(({ branch, effect, observed }) => ({ branch, effect, observed })),
    [{ branch: 'NO_WRITE', effect: 'NONE', observed: null }]);

  const copy = await checked(scope, p => {
    program(p);
    p.steps[1].args.priority = cel('source.priority');
  });
  const unwitnessed = await confirm(copy, [{ ...example, expect: { ...expect, priority: 'normal' } }]);
  assert.equal(unwitnessed.result.passed, true);
  assert.equal(unwitnessed.result.eligible, false);
  await assert.rejects(async () => approve(unwitnessed), { status: 409 });
  const witnessed = await confirm(copy, [{ ...example, priority: 'low', expect: { ...expect, priority: 'low' } }]);
  assert.equal(witnessed.result.eligible, true);

  const revision = await f.activate('maya', artifact, team ? projectId : undefined, [example]);
  const actor = team ? 'leo' : 'maya', source = await f.create(actor, projectId, example.title, []);
  await f.tasks.completeTask(actor, source.id);
  await f.shared.run(f.event(source).id);
  const reactionReceipt = f.event(source).receipt;
  const reaction = f.shared.status(actor, source.id);
  const created = f.tasks.getTask(actor, reaction.receipt.value.id);
  assert.equal(reaction.revisionId, revision);
  assert.deepEqual({ title: created.title, project: created.projectId === projectId ? 'SAME_PROJECT' : null,
    notes: created.notes,
    tags: created.tags, priority: created.priority, dueAt: created.dueAt, linked: created.parentTaskId === source.id,
    assigneeId: created.assigneeId ?? null }, expect);
  assert.deepEqual(f.tasks.listTasks(actor, projectId).find(task => task.id === created.id), created);
  assert.deepEqual(f.tasks.searchTasks(actor, projectId, { q: 'End of instructions' }).items, [created]);
  const savedText = f.db.prepare('SELECT CAST(title AS BLOB) title, CAST(notes AS BLOB) notes FROM tasks WHERE id=?');
  const before = savedText.get(created.id);
  assert.deepEqual(Buffer.from(before.title), Buffer.from(expect.title));
  assert.deepEqual(Buffer.from(before.notes), Buffer.from(expect.notes));
  const title = created.title + ' (renamed)';
  const renamed = f.tasks.editTask(actor, created.id, { title, notes: created.notes });
  assert.deepEqual(renamed, { ...created, title, updatedAt: renamed.updatedAt });
  const after = savedText.get(created.id);
  assert.deepEqual(Buffer.from(after.title), Buffer.from(title));
  assert.deepEqual(after.notes, before.notes);
  assert.equal(f.event(source).receipt, reactionReceipt);
});

test('retained shared check/2 evidence stays exact and cannot certify new creation fields', async () => {
  const harness = 'daymark.shared-completion-check/2', scope = 'PERSONAL', subject = 'maya';
  const full = example(false), { title, dueAt, linked, assigneeId } = full.expect;
  const priorInput = ({ priority, openTitles, ...remaining }) => remaining;
  const cases = [{ ...priorInput(full), expect: { title, dueAt, linked, assigneeId } }, priorInput(noMatch)];
  assert.throws(() => completionOffer(offerFor(artifacts.personal, cases)), { status: 400 });
  const load = (artifact, cases, version) => {
    const source = sources.get(artifact);
    const manifest = scopedCompletionManifest(scope, subject, source, artifact, cases, version);
    return readCompletionManifest(scope, subject, manifest, source, artifact, cases);
  };
  const retained = await checked(scope, undefined, '1');
  const legacy = load(retained, cases, harness), current = load(artifacts.personal, [full, noMatch]);
  assert.equal(Object.hasOwn(legacy.manifest, 'harness'), false);
  const revisionId = randomUUID(), report = await checkSharedCompletion(legacy, revisionId, subject, [], permit);
  assert.equal(report.harness, harness);
  assert.equal(completionProofMatches(legacy, revisionId, report), true);
  assert.equal(completionProofMatches(current, revisionId, report), false);
  assert.throws(() => readCompletionManifest(scope, subject, { ...current.manifest, harness }, sources.get(artifacts.personal),
    artifacts.personal, [full, noMatch]), { status: 503 });
  const check3 = load(retained, [full, noMatch].map(({ openTitles, ...c }) => c), SHARED_CHECK);
  const report3 = await checkSharedCompletion(check3, revisionId, subject, [], permit);
  assert.equal(completionProofMatches(check3, revisionId, report3), true);
  assert.equal(completionProofMatches(current, revisionId, report3), false);
  const check4 = load(await checked(scope, undefined, '2'), [full, noMatch], LOOKUP_CHECK);
  const report4 = await checkSharedCompletion(check4, revisionId, subject, [], permit);
  assert.equal(completionProofMatches(check4, revisionId, report4), true);
  assert.equal(completionProofMatches(current, revisionId, report4), false);
  const retainedPriority = await checked(scope, p => {
    p.steps[2] = { id: 'updated', call: 'tasks.update', when: 'eligible', args: { priority: { literal: 'high' } } };
    p.return.record.status = cel('eligible ? "UPDATED" : "NO_OP"');
  }, '3');
  const priorityCases = [{ ...full, expect: { sourcePriority: 'high' } }, noMatch];
  const check5 = load(retainedPriority, priorityCases, PRIORITY_CHECK);
  const report5 = await checkSharedCompletion(check5, revisionId, subject, [], permit);
  assert.equal(completionProofMatches(check5, revisionId, report5), true);
  assert.equal(completionProofMatches(current, revisionId, report5), false);
  const retainedDue = await checked(scope, p => {
    p.steps[2] = { id: 'updated', call: 'tasks.update', when: 'eligible', args: { clearDue: { literal: true } } };
    p.return.record.status = cel('eligible ? "UPDATED" : "NO_OP"');
  }, '4');
  const check6 = load(retainedDue, [{ ...full, sourceDueAt: occurredAt, expect: { sourceDueAt: null } },
    { ...noMatch, sourceDueAt: null }], DUE_CHECK);
  const report6 = await checkSharedCompletion(check6, revisionId, subject, [], permit);
  assert.equal(completionProofMatches(check6, revisionId, report6), true);
  assert.equal(completionProofMatches(current, revisionId, report6), false);
  const extended = await checked(scope, p => { p.steps[2].args.notes = { literal: 'Not covered by the old report' }; }, '1');
  const notQualified = load(extended, cases, harness), oldReport = await checkSharedCompletion(notQualified, revisionId, subject, [], permit);
  assert.equal(oldReport.passed, true);
  assert.equal(completionProofMatches(notQualified, revisionId, oldReport), false);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: source priority proof and durable completion edit fence`, async t => {
  const team = scope === 'TEAM', actor = team ? 'leo' : 'maya';
  let beforeWrite, lost = false;
  const f = setup(t, undefined, { beforeWrite: () => beforeWrite?.(), writeReply(result) {
    if (lost) throw new Error('Lost priority reply');
    return result;
  } });
  const projectId = f.project('Priority proof', scope);
  if (team) f.projects.addMember('maya', projectId, { userId: actor });
  const artifact = await checked(scope, p => {
    p.steps[2] = { id: 'updated', call: 'tasks.update', when: 'eligible', args: { priority: { literal: 'high' } } };
    p.return.record.status = cel('eligible ? "UPDATED" : "NO_OP"');
  });
  const changed = { ...example(false), expect: { sourcePriority: 'high' } };
  const equal = { ...changed, id: 'equal', priority: 'high' };
  const cases = [changed, equal, noMatch];
  const confirm = examples => f.activate('maya', artifact, team ? projectId : undefined, examples, { confirmOnly: true });
  const approve = draft => team ? f.capability.approve('maya', projectId, draft.input) : f.lifecycle.approve('maya', draft.input, permit);
  const incorrect = await confirm([{ ...changed, expect: { sourcePriority: 'low' } }, noMatch]);
  assert.equal(incorrect.result.passed, false);
  await assert.rejects(async () => approve(incorrect), { status: 409 });
  for (const examples of [[changed], [equal, noMatch]]) {
    const narrow = await confirm(examples);
    assert.equal(narrow.result.passed, true);
    assert.equal(narrow.result.eligible, false);
    await assert.rejects(async () => approve(narrow), { status: 409 });
  }
  const exact = await confirm(cases);
  assert.equal(exact.result.eligible, true);
  const report = team ? f.capability.evidence('maya', projectId, exact.result.evidenceId).report
    : f.lifecycle.evidence('maya', exact.result.evidenceId, exact.input.extensionId);
  assert.deepEqual(report.checks.map(c => c.branch), ['UPDATED', 'UNCHANGED', 'SKIPPED']);
  const complete = async (priority = 'normal', tags = ['for customer']) => {
    const task = await f.tasks.createTask(actor, { projectId, title: 'Review\0brief', notes: 'Preserve\0this', priority, tags, dueAt: occurredAt },
      { operationId: randomUUID() });
    return f.tasks.completeTask(actor, task.id);
  };
  assert.equal(f.event(await complete()), undefined);
  const approval = await approve(exact);
  assert.equal(f.event(await complete()), undefined);
  if (team) await f.capability.activate('maya', projectId, { ...exact.input, operationId: randomUUID(),
    approvalId: approval.receipt.id, expectedSelectionGeneration: exact.generation });
  else f.lifecycle.activate('maya', exact.input, permit);
  const run = async task => {
    const event = f.event(task);
    assert.ok(event);
    assert.equal(await f.shared.run(event.id), true);
    assert.equal(await f.shared.run(event.id), false);
    const status = f.shared.status('maya', task.id);
    assert.equal(status.revisionId, exact.result.revisionId);
    return status;
  };
  const generation = task => f.db.prepare('SELECT 1 FROM shared_priority_fences WHERE source_id=?').get(task.id);
  const beforeRead = await complete();
  assert.ok(generation(beforeRead));
  f.tasks.editTask(actor, beforeRead.id, { priority: 'low' });
  const denied = await run(beforeRead);
  assert.equal(denied.outcome.error.code, 'ACCESS_DENIED');
  assert.equal(denied.receipt, null);
  assert.equal(f.tasks.getTask(actor, beforeRead.id).priority, 'low');

  const restored = await complete();
  beforeWrite = () => {
    const edit = f.db.prepare('UPDATE tasks SET priority=? WHERE id=?');
    edit.run('low', restored.id); edit.run('normal', restored.id);
  };
  assert.equal((await run(restored)).receipt, null);
  assert.deepEqual(f.tasks.getTask(actor, restored.id), restored);
  beforeWrite = undefined;
  const missing = await complete();
  f.db.prepare('DELETE FROM shared_priority_fences WHERE source_id=?').run(missing.id);
  assert.equal((await run(missing)).receipt, null);
  if (team) {
    const removed = await complete();
    beforeWrite = () => f.projects.removeMember('maya', projectId, actor);
    assert.equal((await run(removed)).receipt, null);
    assert.equal(f.tasks.getTask('maya', removed.id).priority, 'normal');
    f.projects.addMember('maya', projectId, { userId: actor });
  }
  beforeWrite = undefined;
  const same = await complete('high');
  const unchanged = await run(same);
  assert.deepEqual(unchanged.observation.updated.before, unchanged.observation.updated.after);
  assert.deepEqual(f.tasks.getTask(actor, same.id), same);
  const skipped = await run(await complete('normal', []));
  assert.equal(skipped.outcome.result.status, 'NO_OP');
  assert.equal(skipped.receipt, null);
  const target = await complete(), taskCount = f.tasks.listTasks(actor, projectId).length;
  lost = true;
  const uncertain = await run(target);
  assert.equal(uncertain.outcome.classification, 'UNCERTAIN');
  assert.equal(uncertain.receipt.value.id, target.id);
  assert.equal(f.tasks.listTasks(actor, projectId).length, taskCount);
  const updated = f.tasks.getTask(actor, target.id);
  assert.deepEqual(updated, { ...target, priority: 'high', updatedAt: updated.updatedAt });
  f.tasks.editTask(actor, target.id, { priority: 'low' });
  const reconciled = f.shared.reaction(actor, target.id, true);
  assert.deepEqual(reconciled.reconciliation.observation, uncertain.observation);
  assert.equal(reconciled.observation.updated.after.priority, 'high');
  assert.equal(f.tasks.getTask(actor, target.id).priority, 'low');
  if (!team) {
    const revoked = await complete();
    const generation = f.lifecycle.state(actor, exact.input.extensionId).selection.generation;
    lost = false;
    beforeWrite = () => f.lifecycle.disable(actor, { extensionId: exact.input.extensionId, generation }, permit);
    const result = await run(revoked);
    assert.equal(result.outcome.error.code, 'ACCESS_DENIED');
    assert.equal(result.receipt, null);
    assert.deepEqual(f.tasks.getTask(actor, revoked.id), revoked);
  }
});

const dueInstant = '2026-03-08T10:30:09.417Z';
for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: source addTag appends only the normalized tag, with exact proof and readback`, async t => {
  const team = scope === 'TEAM', actor = team ? 'leo' : 'maya';
  let lose = false, writeReplies = 0;
  const f = setup(t, undefined, { writeReply(receipt) {
    writeReplies++;
    if (lose) throw new Error('Lost addTag reply');
    return receipt;
  } });
  const projectId = f.project('Sample archive', scope);
  if (team) f.projects.addMember('maya', projectId, { userId: actor });
  const program = (p, addTag) => {
    p.steps[1].let = cel('source.priority == "low" && "samples" in source.tags');
    p.steps[2] = { id: 'updated', call: 'tasks.update', when: 'eligible', args: { addTag } };
    p.return.record.status = cel('eligible ? "UPDATED" : "NO_OP"');
  };
  const artifact = await checked(scope, p => program(p, { literal: ' CAFE\u0301 ' }));
  const inputTags = ['samples', 'intake'], afterTags = ['samples', 'intake', 'café'];
  const changed = { ...example(false), priority: 'low', tags: inputTags, expect: { sourceTags: afterTags } };
  const equal = { ...changed, id: 'already', tags: ['café', ...inputTags], expect: { sourceTags: ['café', ...inputTags] } };
  const skip = { ...noMatch, tags: inputTags }, cases = [changed, equal, skip];
  const confirm = (bytes, cases) => f.activate('maya', bytes, team ? projectId : undefined, cases, { confirmOnly: true });
  const approve = draft => team ? f.capability.approve('maya', projectId, draft.input) : f.lifecycle.approve('maya', draft.input, permit);
  const proof = draft => team ? f.capability.evidence('maya', projectId, draft.result.evidenceId).report
    : f.lifecycle.evidence('maya', draft.result.evidenceId, draft.input.extensionId);
  for (const sourceTags of [['samples', 'intake', 'wrong'], ['intake', 'samples', 'café']]) {
    const wrong = await confirm(artifact, [{ ...changed, expect: { sourceTags } }, skip]);
    assert.equal(wrong.result.passed, false);
    assert.deepEqual(proof(wrong).checks[0].observed, changed.expect);
    await assert.rejects(async () => approve(wrong), { status: 409 });
  }
  const partial = await checked(scope, p => program(p, cel('source.priority == "low" ? "café" : "other"')));
  const unproven = await confirm(partial, cases);
  assert.equal(unproven.result.passed, true);
  assert.equal(unproven.result.eligible, false);
  await assert.rejects(async () => approve(unproven), { status: 409 });
  const bad = await checked(scope, p => program(p, { literal: 'two,tags' }));
  const invalid = await confirm(bad, cases);
  assert.equal(invalid.result.passed, false);
  assert.equal(proof(invalid).checks[0].classification, 'BUSINESS_REJECTION');
  await assert.rejects(async () => approve(invalid), { status: 409 });
  const exact = await confirm(artifact, cases);
  assert.equal(exact.result.eligible, true);
  assert.deepEqual(proof(exact).checks.map(c => c.branch), ['UPDATED', 'UNCHANGED', 'SKIPPED']);
  const approval = await approve(exact);
  if (team) await f.capability.activate('maya', projectId, { ...exact.input, operationId: randomUUID(),
    approvalId: approval.receipt.id, expectedSelectionGeneration: exact.generation });
  else f.lifecycle.activate('maya', exact.input, permit);

  const complete = async (tags, priority = 'low') => {
    const task = await f.tasks.createTask(actor, { projectId, title: 'Catalog\0sample', notes: 'Keep\0this', tags, priority, dueAt: dueInstant },
      { operationId: randomUUID() });
    return f.tasks.completeTask(actor, task.id);
  };
  const run = async task => {
    const event = f.event(task);
    assert.equal(await f.shared.run(event.id), true);
    assert.equal(await f.shared.run(event.id), false);
    const result = f.shared.status(actor, task.id);
    assert.equal(result.revisionId, exact.result.revisionId);
    return result;
  };
  const filled = await complete([...inputTags, 'a', 'b', 'c', 'd', 'e', 'f']);
  const denied = await run(filled);
  assert.equal(denied.outcome.error.code, 'TASK_INVALID');
  assert.equal(denied.receipt, null);
  assert.deepEqual(f.tasks.getTask(actor, filled.id), filled);
  const present = await complete([' CAFE\u0301 ', ...inputTags, 'a', 'b', 'c', 'd', 'e']);
  const unchanged = await run(present);
  assert.deepEqual(unchanged.observation.updated.before, unchanged.observation.updated.after);
  assert.deepEqual(f.tasks.getTask(actor, present.id), present);
  const skipped = await run(await complete(inputTags, 'high'));
  assert.equal(skipped.receipt, null);
  assert.ok(skipped.outcome.trace.some(entry => entry.event === 'STEP_SKIPPED' && entry.step === 'updated'));
  const stale = await complete(inputTags);
  f.tasks.editTask(actor, stale.id, { tags: ['samples', 'human'] });
  assert.equal((await run(stale)).outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(f.tasks.getTask(actor, stale.id).tags, ['samples', 'human']);
  const task = await complete(inputTags);
  lose = true;
  const result = await run(task);
  assert.equal(result.outcome.classification, 'UNCERTAIN');
  assert.deepEqual(result.receipt.value, { id: task.id });
  const actual = f.tasks.getTask(actor, task.id);
  assert.deepEqual(actual, { ...task, tags: afterTags, updatedAt: actual.updatedAt });
  f.tasks.editTask(actor, task.id, { tags: ['human'] });
  const reconciled = f.shared.reaction(actor, task.id, true);
  assert.equal(reconciled.originalKey, result.originalKey);
  assert.deepEqual(reconciled.reconciliation.receipt, result.receipt);
  assert.deepEqual(reconciled.reconciliation.observation, result.observation);
  assert.deepEqual(reconciled.observation.updated.after.tags, afterTags);
  assert.deepEqual(f.tasks.getTask(actor, task.id).tags, ['human']);
  assert.equal(writeReplies, 2);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: source due date sets or clears exactly on the fenced update`, async t => {
  const team = scope === 'TEAM', actor = team ? 'leo' : 'maya';
  let lose = false;
  const f = setup(t, undefined, { writeReply(receipt) {
    if (lose) throw new Error('Lost due-date reply');
    return receipt;
  } });
  const projectId = f.project('Return samples', scope);
  if (team) f.projects.addMember('maya', projectId, { userId: actor });
  const program = (p, args) => {
    p.steps[1].let = cel('source.title == "Return samples" && source.priority == "low"');
    p.steps[2] = { id: 'updated', call: 'tasks.update', when: 'eligible', args };
    p.return.record.status = cel('eligible ? "UPDATED" : "NO_OP"');
  };
  const setArgs = { dueAt: cel(`timestamp("${dueInstant}")`) };
  const compileUpdate = args => checked(scope, p => program(p, args));
  const set = await compileUpdate(setArgs), clear = await compileUpdate({ clearDue: { literal: true } });
  const casesFor = (from, to) => [
    { ...example(false), title: 'Return samples', priority: 'low', sourceDueAt: from, expect: { sourceDueAt: to } },
    { ...example(false), id: 'already', title: 'Return samples', priority: 'low', sourceDueAt: to, expect: { sourceDueAt: to } },
    { ...noMatch, title: 'Return samples', sourceDueAt: from },
  ];
  const setCases = casesFor(null, dueInstant), clearCases = casesFor(dueInstant, null);
  const select = (artifact, cases, confirmOnly = false) => f.activate('maya', artifact, team ? projectId : undefined, cases, { confirmOnly });
  const approve = draft => team ? f.capability.approve('maya', projectId, draft.input)
    : f.lifecycle.approve('maya', draft.input, permit);
  const mismatch = await select(set, [{ ...setCases[0], expect: { sourceDueAt: '2026-03-08T10:30:09.418Z' } }, setCases[2]], true);
  assert.equal(mismatch.result.passed, false);
  await assert.rejects(async () => approve(mismatch), { status: 409 });
  const thin = await select(clear, clearCases.slice(1), true);
  assert.equal(thin.result.passed, true);
  assert.equal(thin.result.eligible, false);
  await assert.rejects(async () => approve(thin), { status: 409 });
  const partialArtifact = await compileUpdate({ dueAt: cel('source.priority == "low" ? timestamp("2026-03-08T10:30:09.417Z") : timestamp("2026-03-08T10:30:09.418Z")') });
  const partial = await select(partialArtifact, setCases, true);
  assert.equal(partial.result.passed, true);
  assert.equal(partial.result.eligible, false);
  await assert.rejects(async () => approve(partial), { status: 409 });
  const elapsed = await compileUpdate({ dueAt: cel('input.occurredAt + duration("90s")') });
  assert.equal((await select(elapsed, casesFor(null, '2026-03-07T16:01:30.417Z'), true)).result.eligible, true);
  for (const args of [{}, { clearDue: { literal: false } }, { ...setArgs, clearDue: { literal: true } }]) {
    const invalid = await select(await compileUpdate(args), setCases, true);
    assert.equal(invalid.result.passed, false);
    await assert.rejects(async () => approve(invalid), { status: 409 });
  }
  const complete = async (dueAt, priority = 'low') => {
    const task = await f.tasks.createTask(actor,
      { projectId, title: 'Return samples', priority, notes: 'Keep\0these notes', tags: ['samples'], dueAt }, { operationId: randomUUID() });
    return f.tasks.completeTask(actor, task.id);
  };
  const run = async (task, revision) => {
    const event = f.event(task);
    assert.equal(await f.shared.run(event.id), true);
    const result = f.shared.status(actor, task.id);
    assert.equal(result.revisionId, revision);
    assert.equal(await f.shared.run(event.id), false);
    return result;
  };
  for (const [artifact, cases] of [[set, setCases], [clear, clearCases]]) {
    const from = cases[0].sourceDueAt, to = cases[0].expect.sourceDueAt;
    const revision = await select(artifact, cases);
    const stale = await complete(from);
    f.tasks.editTask(actor, stale.id, { dueAt: occurredAt });
    assert.equal((await run(stale, revision)).outcome.error.code, 'ACCESS_DENIED');
    assert.equal(f.tasks.getTask(actor, stale.id).dueAt, occurredAt);
    const equal = await complete(to), equalResult = await run(equal, revision);
    assert.deepEqual(equalResult.observation.updated.before, equalResult.observation.updated.after);
    assert.deepEqual(f.tasks.getTask(actor, equal.id), equal);
    const skip = await run(await complete(from, 'high'), revision);
    assert.equal(skip.receipt, null);
    assert.ok(skip.outcome.trace.some(entry => entry.event === 'STEP_SKIPPED' && entry.step === 'updated'));
    const task = await complete(from);
    lose = true;
    const result = await run(task, revision);
    lose = false;
    assert.equal(result.outcome.classification, 'UNCERTAIN');
    assert.deepEqual(result.receipt.value, { id: task.id });
    const actual = f.tasks.getTask(actor, task.id);
    assert.deepEqual(actual, { ...task, dueAt: to, updatedAt: actual.updatedAt });
    f.tasks.editTask(actor, task.id, { dueAt: occurredAt });
    const reconciled = f.shared.reaction(actor, task.id, true);
    assert.equal(reconciled.originalKey, result.originalKey);
    assert.deepEqual(reconciled.reconciliation, { observedAt: reconciled.reconciliation.observedAt,
      capability: 'tasks.update', receipt: result.receipt, observation: result.observation });
    assert.equal(reconciled.observation.updated.after.dueAt, to);
    assert.equal(f.tasks.getTask(actor, task.id).dueAt, occurredAt);
  }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: scoped open-title lookup observes and rechecks the exact match before writing`, async t => {
  let beforeWrite, injected;
  const f = setup(t, undefined, { beforeWrite: () => beforeWrite?.(), faultBinding: () => injected });
  const team = scope === 'TEAM', projectId = f.project('Dispatch', scope), otherId = f.project('Other', scope);
  const actor = team ? 'leo' : 'maya', title = 'Dispatch audit';
  if (team) f.projects.addMember('maya', projectId, { userId: actor });
  const program = (p, destination = cel('source.projectId')) => {
    p.steps.splice(1, 2,
      { id: 'lookup', call: 'tasks.openMatch', args: { projectId: destination, title: { literal: title } } },
      { id: 'eligible', let: cel('source.priority == "high" && !lookup.matches') },
      { id: 'created', call: 'tasks.create', when: 'eligible',
        args: { projectId: cel('source.projectId'), title: { literal: title } } });
  };
  const artifact = await checked(scope, p => program(p));
  const positive = { ...example(false), priority: 'high', expect: { ...example(false).expect, title, dueAt: null },
    openTitles: ['Dispatch  audit', 'Dispatch audit\0suffix'] };
  const negative = { ...positive, id: 'hit', expect: null, openTitles: [...positive.openTitles, title].reverse() };
  const cases = [positive, negative];
  const confirm = examples => f.activate('maya', artifact, team ? projectId : undefined, examples, { confirmOnly: true });
  const approve = draft => team ? f.capability.approve('maya', projectId, draft.input)
    : f.lifecycle.approve('maya', draft.input, permit);
  await assert.rejects(confirm([positive, { ...negative, openTitles: [title + ' '] }]), { status: 400 });
  const blocked = await confirm([positive, { ...negative, openTitles: [...positive.openTitles, 'Dispatch Audit'] }]);
  assert.equal(blocked.result.passed, false);
  for (const invalidWitness of [{ ...negative, priority: 'low' }, { ...negative, openTitles: [title] }]) {
    const draft = await confirm([positive, invalidWitness]);
    assert.equal(draft.result.passed, true);
    assert.equal(draft.result.eligible, false);
    await assert.rejects(async () => approve(draft), { status: 409 });
  }
  const exact = await confirm(cases);
  assert.equal(exact.result.passed, true);
  assert.equal(exact.result.eligible, true);
  const proof = team ? f.capability.evidence('maya', projectId, exact.result.evidenceId).report
    : f.lifecycle.evidence('maya', exact.result.evidenceId, exact.input.extensionId);
  assert.deepEqual(proof.checks.map(c => [c.branch, c.openMatches]), [
    ['CREATED', [{ title, matches: false }]], ['SKIPPED', [{ title, matches: true }]],
  ]);
  const source = title => f.tasks.createTask(actor, { projectId, title, priority: 'high' }, { operationId: randomUUID() });
  const complete = async task => {
    await f.tasks.completeTask(actor, task.id);
    return f.event(task);
  };
  assert.equal(await complete(await source('Before activation')), undefined);
  const approval = await approve(exact);
  assert.equal(await complete(await source('Approved only')), undefined);
  if (team) await f.capability.activate('maya', projectId, { ...exact.input, operationId: randomUUID(),
    approvalId: approval.receipt.id, expectedSelectionGeneration: exact.generation });
  else f.lifecycle.activate('maya', exact.input, permit);

  const run = async label => {
    const task = await source(label), event = await complete(task);
    assert.equal(await f.shared.run(event.id), true);
    const result = f.shared.status('maya', task.id);
    assert.equal(result.revisionId, exact.result.revisionId);
    assert.equal(await f.shared.run(event.id), false);
    return result;
  };
  // Use native rows, not matching-response stubs. The closed exact title predates the activation for Team.
  const add = (project, text, status = 'open') => f.db.prepare(`INSERT INTO tasks
    (id,owner_id,project_id,title,notes,status,created_at,updated_at,creator_id,completed_at) VALUES (?,'maya',?,?,'',?,?,?,?,?)`)
    .run(randomUUID(), project, text, status, occurredAt, occurredAt, team ? 'maya' : null, status === 'completed' ? occurredAt : null);
  add(otherId, title);
  add(projectId, title, 'completed');
  add(projectId, title.toLowerCase());
  add(projectId, title + '\0suffix');
  const wrong = await checked(scope, p => program(p, { literal: otherId, type: 'ProjectId' }));
  const subject = team ? projectId : 'maya', wrongSource = sources.get(wrong);
  injected = readCompletionManifest(scope, subject, scopedCompletionManifest(scope, subject, wrongSource, wrong, cases), wrongSource, wrong, cases);
  const denied = await run('Wrong lookup project');
  assert.equal(denied.outcome.error.code, 'ACCESS_DENIED');
  assert.equal(denied.receipt, null);
  injected = undefined;
  beforeWrite = () => add(projectId, title);
  const changed = await run('Changed since lookup');
  assert.equal(changed.outcome.error.code, 'ACCESS_DENIED');
  assert.equal(changed.receipt, null);
  beforeWrite = undefined;
  const hit = await run('Exact hit');
  assert.deepEqual(hit.outcome.result, { status: 'NO_OP' });
  assert.equal(hit.receipt, null);
  f.db.prepare("DELETE FROM tasks WHERE project_id=? AND status='open' AND title COLLATE BINARY=?").run(projectId, title);
  if (team) {
    beforeWrite = () => f.projects.removeMember('maya', projectId, actor);
    const lost = await run('Current member removed');
    assert.equal(lost.outcome.classification, 'BUSINESS_REJECTION');
    assert.equal(lost.receipt, null);
    f.projects.addMember('maya', projectId, { userId: actor });
  }
  beforeWrite = undefined;
  const miss = await run('Only near misses');
  assert.equal(miss.receipt.effect, 'CONFIRMED');
  assert.equal(f.tasks.getTask(actor, miss.receipt.value.id).title, title);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks WHERE project_id=? AND status='open' AND title COLLATE BINARY=?").get(projectId, title).n, 1);
});

test('Team replaces an exact revoked outgoing head without reopening its pending effect or changing its receipt', async t => {
  const { db, shared, tasks, project, create, event, projects, capability, activate } = setup(t);
  const projectId = project('Replacement', 'TEAM');
  projects.addMember('maya', projectId, { userId: 'leo' });
  const first = await activate('maya', artifacts.team, projectId);
  const done = await create('maya', projectId, 'Already written'), pending = await create('maya', projectId, 'Pending');
  await tasks.completeTask('maya', done.id);
  await tasks.completeTask('maya', pending.id);
  await shared.run(event(done).id);
  const receipt = event(done).receipt, state = capability.state('maya', projectId);
  assert.ok(receipt);
  await capability.revoke('maya', projectId, { operationId: randomUUID(), targetRevisionId: first,
    expectedSelectionRevisionId: first, expectedSelectionGeneration: state.selection.generation });
  const next = capability.state('maya', projectId), offer = offerFor(artifacts.linked, [example(true), noMatch]);
  assert.equal(next.draft.revisionId, first);
  assert.equal(next.draft.revoked, true);
  await assert.rejects(capability.confirmSharedCompletion('maya', projectId, { expectedDraftVersion: next.draftVersion,
    expectedSelectionGeneration: state.selection.generation, offer }), { status: 409 });
  const replacement = await activate('maya', artifacts.linked, projectId);
  assert.notEqual(replacement, first);
  assert.equal(capability.state('maya', projectId).selection.revisionId, replacement);
  await assert.rejects(shared.run(event(pending).id), { status: 409 });
  assert.equal(event(pending).state, 'PENDING');
  assert.equal(event(pending).receipt, null);
  assert.equal(event(done).receipt, receipt);
  assert.equal(db.prepare('SELECT revoked_at FROM team_revisions WHERE project_id=? AND revision_id=?').get(projectId, first).revoked_at !== null, true);
  const fresh = await create('leo', projectId, 'New policy');
  await tasks.completeTask('leo', fresh.id);
  await shared.run(event(fresh).id);
  const result = shared.status('leo', fresh.id);
  assert.equal(result.revisionId, replacement);
  assert.equal(result.receipt.effect, 'CONFIRMED');
  assert.equal(tasks.getTask('leo', result.receipt.value.id).parentTaskId, fresh.id);
});

test('one native completion path in both scopes; exact tag, title and elapsed due; Team can add verified link and assignee atomically', async t => {
  const { db, shared, tasks, project, create, event, team, projects, capability, activate } = setup(t);
  for (const [scope, artifact, projectName, linked] of [
    ['PERSONAL', artifacts.personal, 'Private work', false],
    ['TEAM', artifacts.team, 'Shared unlinked', false],
    ['TEAM', artifacts.linked, 'Shared linked', true],
  ]) {
    const projectId = project(projectName, scope);
    const teamScope = scope === 'TEAM';
    if (teamScope) projects.addMember('maya', projectId, { userId: 'leo' });
    const absent = await create('maya', projectId, 'Explicit absence');
    await tasks.completeTask('maya', absent.id);
    assert.equal(event(absent), undefined);
    const pin = await activate('maya', artifact, teamScope ? projectId : undefined, [example(linked), noMatch]);
    const actor = teamScope ? 'leo' : 'maya';
    const yes = await create(actor, projectId, 'Call José!'), no = await create(actor, projectId, 'Close near miss', ['for customers']);
    if (teamScope) {
      const active = capability.state('maya', projectId).selection;
      await capability.deactivate('maya', projectId, { operationId: randomUUID(), targetRevisionId: pin,
        expectedSelectionRevisionId: pin, expectedSelectionGeneration: active.generation });
    }
    if (teamScope) {
      await assert.rejects(async () => tasks.completeTask('sam', yes.id), { status: 404 });
      assert.equal(event(yes), undefined);
    }
    const completed = await tasks.completeTask(actor, yes.id);
    const captured = event(yes);
    assert.equal(shared.status(actor, yes.id).revisionId, pin);
    assert.equal(captured.actor_id, actor);
    assert.equal(captured.occurred_at, completed.completedAt);
    if (teamScope) {
      const root = db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(yes.id);
      assert.equal(root.policy_state, 'PINNED');
      assert.equal(root.state, 'NO_HOOK');
      assert.equal(captured.root_id, root.event_id);
      assert.notEqual(captured.original_key, root.original_key);
      assert.equal(root.receipt, null);
    }
    await tasks.completeTask(actor, yes.id);
    assert.deepEqual(event(yes), captured);
    assert.deepEqual(await Promise.all([shared.run(captured.id), shared.run(captured.id)]), [true, false]);
    const status = shared.status(actor, yes.id);
    assert.equal(status.outcome.classification, 'COMPLETED');
    assert.equal(status.receipt.effect, 'CONFIRMED');
    const created = tasks.getTask(actor, status.receipt.value.id);
    assert.equal(created.title, 'Call José! follow up');
    assert.equal(created.dueAt, due(completed));
    assert.equal(created.projectId, projectId);
    assert.equal(created.parentTaskId ?? null, linked ? yes.id : null);
    assert.equal(created.assigneeId ?? null, linked ? 'leo' : null);
    assert.equal(shared.verifiedCreatedTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(created.id)), true);
    assert.equal(db.prepare('SELECT 1 FROM task_events WHERE source_task_id=?').get(created.id), undefined);
    assert.equal(db.prepare('SELECT 1 FROM team_admissions WHERE source_task_id=?').get(created.id), undefined);
    if (teamScope) assert.equal(team.status(actor, created.id).state, 'NO_BINDING');
    await tasks.completeTask(actor, created.id);
    if (teamScope) {
      assert.equal(event(created), undefined);
      assert.equal(db.prepare('SELECT 1 FROM task_events WHERE source_task_id=?').get(created.id), undefined);
    } else {
      const childEvent = event(created);
      assert.notEqual(childEvent.original_key, captured.original_key);
      assert.equal(await shared.run(childEvent.id), true);
      assert.equal(shared.status(actor, created.id).outcome.result.status, 'NO_OP');
      assert.equal(shared.status(actor, created.id).receipt, null);
    }
    await tasks.completeTask(actor, no.id);
    assert.notEqual(event(no).original_key, captured.original_key);
    await shared.run(event(no).id);
    assert.deepEqual(shared.status(actor, no.id).outcome.result, { status: 'NO_OP' });
    assert.deepEqual(shared.status(actor, no.id).outcome.effects, []);
    assert.equal(shared.status(actor, no.id).receipt, null);
  }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope} Confirm, Approve and Turn on are exact, separate gates`, async t => {
  let revokeBeforeWrite;
  const { db, shared, tasks, project, create, event, lifecycle, capability, activate } =
    setup(t, undefined, { clock: () => 0, beforeWrite: () => revokeBeforeWrite?.() });
  const team = scope === 'TEAM', artifact = team ? artifacts.team : artifacts.personal;
  const projectId = project('Exact lifecycle', scope);
  const otherTeam = team && project('Different Team', scope);
  const siblingRows = () => db.prepare("SELECT * FROM extension_selections WHERE hook_id!='TaskCompleted'").all();
  const siblings = siblingRows();
  const confirm = cases => activate('maya', artifact, team ? projectId : undefined, cases, { confirmOnly: true, keepSlot: true });
  const approve = ({ input }) => team ? capability.approve('maya', projectId, input) : lifecycle.approve('maya', input, permit);
  const turnOn = ({ input, generation }, approval, overrides = {}) => team
    ? capability.activate('maya', projectId, { ...input, operationId: randomUUID(), approvalId: approval,
      expectedSelectionGeneration: generation, ...overrides })
    : lifecycle.activate('maya', { ...input, ...overrides }, permit);
  const selection = candidate => team ? capability.state('maya', projectId).selection : lifecycle.state('maya', candidate.input.extensionId).selection;
  const noEffect = async label => {
    const task = await create('maya', projectId, label);
    await tasks.completeTask('maya', task.id);
    assert.equal(event(task), undefined);
    return task;
  };
  const mismatch = await confirm([{ ...example(false), expect: null }]);
  assert.equal(mismatch.result.passed, false);
  await assert.rejects(async () => approve(mismatch), { status: 409 });
  db.prepare(`DELETE FROM ${team ? 'team_evidence' : 'extension_evidence'} WHERE id=?`).run(mismatch.result.evidenceId);
  await assert.rejects(async () => approve(mismatch), { status: 404 });
  await noEffect('Checked but mismatched');
  const unavailable = await confirm([example(false), noMatch]);
  const { revisionId } = unavailable.result;
  assert.equal(unavailable.result.passed, true);
  if (team) {
    db.exec('DROP TRIGGER team_revision_immutable');
    db.prepare("UPDATE team_revisions SET artifacts='{}' WHERE project_id=? AND revision_id=?").run(projectId, revisionId);
    assert.equal(capability.state('maya', projectId).eligibility.eligible, false);
  } else {
    db.prepare('DELETE FROM extension_authored WHERE revision_id=?').run(revisionId);
    await assert.rejects(async () => lifecycle.source('maya', revisionId, unavailable.input.extensionId), { status: 404 });
  }
  await assert.rejects(async () => approve(unavailable), { status: 409 });
  const exact = await confirm([example(false), noMatch]), chosen = exact.result.revisionId;
  const manifest = team ? capability.source('maya', projectId, chosen).manifest
    : lifecycle.source('maya', chosen, exact.input.extensionId).pins;
  const read = (shape, bytes) => readCompletionManifest(scope, team ? projectId : 'maya', shape, sources.get(artifact), bytes, [example(false), noMatch]);
  assert.equal(read(manifest, artifact).manifest.hooks.TaskBeforeComplete, null);
  const omitted = structuredClone(manifest); delete omitted.hooks.TaskBeforeComplete;
  for (const [shape, bytes] of [[omitted, artifact], [{ ...manifest, format: 'unknown/1' }, artifact],
    [manifest, null], [manifest, Buffer.from('{}')]]) assert.throws(() => read(shape, bytes), { status: 503 });
  const beforeSelection = selection(exact);
  await noEffect('Confirmed, not approved');
  const approvalId = (await approve(exact))?.receipt?.id;
  assert.deepEqual(selection(exact), beforeSelection);
  const beforeTurnOn = await noEffect('Approved, not on');
  if (team) {
    await assert.rejects(capability.approve('maya', otherTeam, exact.input), { status: 404 });
    await assert.rejects(turnOn(exact, approvalId, { expectedSelectionGeneration: exact.generation + 1 }), { status: 409 });
  } else {
    assert.throws(() => lifecycle.approve('leo', exact.input, permit), { status: 404 });
    await assert.rejects(async () => turnOn(exact, null, { generation: exact.input.generation + 1 }), { status: 409 });
  }
  await turnOn(exact, approvalId);
  await assert.rejects(async () => turnOn(exact, approvalId), { status: 409 });
  assert.deepEqual(siblingRows(), siblings);
  assert.equal(event(beforeTurnOn), undefined);
  const task = await create('maya', projectId, 'Revocation source');
  await tasks.completeTask('maya', task.id);
  const waiting = await create('maya', projectId, 'Already admitted');
  await tasks.completeTask('maya', waiting.id);
  const pending = event(task), before = db.prepare('SELECT count(*) n FROM tasks').get().n;
  const revoke = () => team ? capability.revoke('maya', projectId, { operationId: randomUUID(), targetRevisionId: chosen,
    expectedSelectionRevisionId: chosen, expectedSelectionGeneration: selection(exact).generation })
    : lifecycle.disable('maya', { extensionId: exact.input.extensionId, generation: selection(exact).generation }, permit);
  let revocations = 0;
  revokeBeforeWrite = () => { revocations++; return revoke(); };
  assert.equal(await shared.run(pending.id), true);
  assert.equal(revocations, 1);
  assert.equal(shared.status('maya', task.id).outcome.error.code, 'ACCESS_DENIED');
  assert.equal(shared.status('maya', task.id).receipt, null);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, before);
  assert.equal(await shared.run(pending.id), false);
  await assert.rejects(shared.run(event(waiting).id), { status: team ? 409 : 503 });
  assert.equal(event(waiting).state, 'PENDING');
  assert.equal(event(waiting).receipt, null);
  await noEffect('Turned off');
  assert.equal(revocations, 1);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope} preserves exact title bytes and rejects a suffix-only edit before commit`, async t => {
  let edit;
  const { db, shared, tasks, project, create, event, projects, activate } = setup(t, undefined, { beforeWrite: () => edit?.() });
  const team = scope === 'TEAM', projectId = project('Exact titles', scope), actor = team ? 'leo' : 'maya';
  if (team) projects.addMember('maya', projectId, { userId: actor });
  await activate('maya', team ? artifacts.linked : artifacts.personal, team ? projectId : undefined);
  const readTitle = id => Buffer.from(db.prepare('SELECT CAST(title AS BLOB) AS title FROM tasks WHERE id=?').get(id).title);
  const title = 'A\0B', expected = Buffer.from('A\0B follow up');

  const source = await create(actor, projectId, title);
  assert.deepEqual(readTitle(source.id), Buffer.from(title));
  await tasks.completeTask(actor, source.id);
  const captured = event(source);
  assert.equal(await shared.run(captured.id), true);
  const saved = event(source), receipt = JSON.parse(saved.receipt);
  const observed = shared.status(actor, source.id);
  assert.equal(observed.receipt.effect, 'CONFIRMED');
  assert.equal(saved.created_task_id, observed.receipt.value.id);
  assert.deepEqual(readTitle(saved.created_task_id), expected);
  assert.deepEqual(Buffer.from(JSON.parse(receipt.payload).title), expected);
  assert.equal(receipt.originalKey, captured.original_key);

  const changed = await create(actor, projectId, title);
  await tasks.completeTask(actor, changed.id);
  const taskCount = () => db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  const before = taskCount();
  let edits = 0;
  edit = () => {
    edits++;
    db.prepare('UPDATE tasks SET title=? WHERE id=?').run('A\0C', changed.id);
  };
  assert.equal(await shared.run(event(changed).id), true);
  assert.equal(edits, 1);
  assert.deepEqual(readTitle(changed.id), Buffer.from('A\0C'));
  assert.equal(taskCount(), before);
  assert.equal(event(changed).created_task_id, null);
  assert.equal(event(changed).receipt, null);
  const denied = shared.status(actor, changed.id);
  assert.equal(denied.outcome.classification, 'BUSINESS_REJECTION');
  assert.equal(denied.outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(denied.outcome.effects.map(effect => effect.state), ['NONE']);
});

test('commit rechecks actor, assignee, destination and source facts; uncertain write reply reads back exact receipt without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shared-completion-restart-')), path = join(directory, 'app.sqlite');
  let beforeWrite, injected, replyLost = false;
  const f = setup(t, openData(path), { cleanup: () => rmSync(directory, { recursive: true, force: true }),
    faultBinding: () => injected, beforeWrite: () => beforeWrite?.(), writeReply: value => {
    if (replyLost) throw new Error('Synthetic lost reply after native commit');
    return value;
  } });
  const { db, shared, tasks, project, create, event, projects, activate } = f;
  const teamId = project('Team source', 'TEAM'), otherTeam = project('Wrong Team destination', 'TEAM');
  const foreign = project('Foreign private destination', 'PERSONAL', 'sam');
  const personal = project('Personal source', 'PERSONAL');
  const attempt = async ({ source = teamId, actor = 'maya', faultArtifact, afterActivation, held, outcome, code }) => {
    beforeWrite = held;
    const privateScope = source === personal;
    await activate('maya', privateScope ? artifacts.personal : artifacts.linked, privateScope ? undefined : source);
    if (faultArtifact) {
      const scope = privateScope ? 'PERSONAL' : 'TEAM', subject = privateScope ? 'maya' : source, code = sources.get(faultArtifact);
      const manifest = scopedCompletionManifest(scope, subject, code, faultArtifact, [noMatch]);
      injected = readCompletionManifest(scope, subject, manifest, code, faultArtifact, [noMatch]);
    }
    afterActivation?.();
    const task = await create(actor, source, 'Source');
    await tasks.completeTask(actor, task.id);
    const count = () => db.prepare('SELECT count(*) AS n FROM tasks').get().n;
    const before = count(), captured = event(task);
    await shared.run(captured.id);
    injected = undefined;
    assert.equal(count(), before + (replyLost ? 1 : 0));
    const observed = shared.status('maya', task.id);
    assert.equal(observed.outcome.classification, outcome);
    if (code) assert.equal(observed.outcome.error.code, code);
    assert.equal(await shared.run(captured.id), false);
    assert.equal(count(), before + (replyLost ? 1 : 0));
    return { task, observed, captured };
  };
  const destination = (scope, id) => checked(scope, p => { p.steps[2].args.projectId = { literal: id, type: 'ProjectId' }; });
  projects.addMember('maya', teamId, { userId: 'leo' });
  await attempt({ faultArtifact: await destination('TEAM', otherTeam), outcome: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });
  await attempt({ source: personal, faultArtifact: await destination('PERSONAL', foreign), outcome: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND' });
  await attempt({ afterActivation: () => projects.removeMember('maya', teamId, 'leo'), outcome: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });
  projects.addMember('maya', teamId, { userId: 'leo' });
  await assert.rejects(activate('leo', artifacts.linked, teamId), { status: 403 });
  await attempt({ held: () => projects.removeMember('maya', teamId, 'leo'), outcome: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });
  projects.addMember('maya', teamId, { userId: 'leo' });
  await attempt({ actor: 'leo', held: () => projects.removeMember('maya', teamId, 'leo'), outcome: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND' });
  projects.addMember('maya', teamId, { userId: 'leo' });
  await attempt({ held: () => db.prepare("UPDATE tasks SET title='Edited during the check' WHERE id=(SELECT source_id FROM shared_completion_events WHERE state='STARTED')").run(),
    outcome: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });
  replyLost = true;
  const { task, observed, captured } = await attempt({ outcome: 'UNCERTAIN' });
  assert.equal(observed.outcome.effects[0].state, 'UNKNOWN');
  assert.equal(observed.receipt.effect, 'CONFIRMED');
  replyLost = false;
  db.exec(`CREATE TEMP TRIGGER reject_shared_receipt BEFORE UPDATE OF receipt ON shared_completion_events
    WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic receipt insert failure'); END`);
  const rolledBack = await attempt({ outcome: 'UNCERTAIN' });
  assert.equal(rolledBack.observed.receipt, null);
  const reopened = openData(path);
  try {
    const reopenedService = createSharedCompletion({ db: reopened, beforeWrite: () => assert.fail('Uncertain write replayed') });
    assert.equal(await reopenedService.run(captured.id), false);
    assert.deepEqual(reopenedService.status('maya', task.id), observed);
    assert.deepEqual(reopenedService.status('maya', rolledBack.task.id), rolledBack.observed);
    assert.throws(() => reopenedService.status('sam', task.id), { status: 404 });
  } finally { reopened.close(); }
  const denied = db.prepare("SELECT * FROM shared_completion_events WHERE outcome LIKE '%ACCESS_DENIED%' LIMIT 1").get();
  assert.equal(denied.receipt, null);
  assert.deepEqual(JSON.parse(denied.outcome).effects.map(entry => entry.state), ['NONE']);
});

test('populated schema 19 upgrades additively; saved Personal proofs and Team PINNED/NO_POLICY do not become new bindings', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shared-completion-'));
  const path = join(directory, 'app.sqlite');
  let managed = false;
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  t.after(() => { if (!managed) { db?.close(); cleanup(); } });
  let db = openData(path);
  const oldTeam = createTeamRuntime({ db }), oldTasks = taskService(db, { team: oldTeam });
  restoreSavedCore(db, JSON.parse(readFileSync(new URL('./fixtures/saved-core-0.4.0.json', import.meta.url))));
  const oldPersonal = seedTaskEffectBinding(db, 'leo');
  db.prepare("UPDATE extension_selections SET generation=1,revision_id=?,binding_pins=? WHERE owner_id='leo' AND hook_id='TaskCompleted'")
    .run(oldPersonal.revisionId, JSON.stringify(oldPersonal.pins));
  const projectId = oldTasks.createProject('maya', { name: 'Legacy Team', mode: 'TEAM' }).id;
  const noPolicy = await oldTasks.createTask('maya', { projectId, title: 'Legacy no policy' }, { operationId: randomUUID() });
  const source = linkedProposal().bindings.TaskBeforeComplete;
  const legacy = await createCompiler({ modelBytes: teamModelBytes }).compile(Buffer.from(source));
  assert.deepEqual(legacy.diagnostics, []);
  installTeamRevision(db, 'maya', projectId, 'old-pinned', { TaskCreated: null, TaskBeforeComplete: legacy.artifact });
  teamProjectService(db).setSelection('maya', projectId, 'old-pinned');
  const pinned = await oldTasks.createTask('maya', { projectId, title: 'Legacy pinned' }, { operationId: randomUUID() });
  await oldTeam.close();
  db.exec(`DROP TRIGGER shared_created_update_personal; DROP TRIGGER shared_created_update_team; DROP TRIGGER shared_created_update_edit;
    DROP TRIGGER shared_priority_fence_edit; ${sharedCompletionTables.map(table => 'DROP TABLE ' + table).join(';')}; PRAGMA user_version=19`);
  const oldTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  const snapshot = db => oldTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot(db);
  db.close();
  db = null;
  assert.throws(() => openData(path, { allowUpgrade: false }), /Unsupported database/);
  const bytes = readFileSync(path), exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'PRAGMA user_version=24') throw new Error('Shared completion migration interrupted');
    return exec.call(this, sql);
  };
  try { assert.throws(() => openData(path), /Shared completion migration interrupted/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(readFileSync(path), bytes);
  db = openData(path);
  const { tasks, capability, activate } = setup(t, db, { cleanup });
  managed = true;
  const event = task => db.prepare('SELECT 1 FROM shared_completion_events WHERE source_id=?').get(task.id);
  const create = (actor, projectId, title) => tasks.createTask(actor, { projectId, title, tags: ['for customer'] }, { operationId: randomUUID() });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  assert.deepEqual(snapshot(db), before);
  const proposed = await activate('maya', artifacts.team, projectId, [example(false), noMatch], { confirmOnly: true, keepSlot: true });
  const approved = await capability.approve('maya', projectId, proposed.input);
  await assert.rejects(capability.activate('maya', projectId, { ...proposed.input, operationId: randomUUID(),
    approvalId: approved.receipt.id, expectedSelectionGeneration: proposed.generation }), { status: 409 });
  const deniedRoot = await create('maya', projectId, 'Both policy and new pin');
  await assert.rejects(tasks.completeTask('maya', deniedRoot.id), { status: 422 });
  await capability.deactivate('maya', projectId, { operationId: randomUUID(), targetRevisionId: 'old-pinned',
    expectedSelectionRevisionId: 'old-pinned', expectedSelectionGeneration: proposed.generation });
  await capability.activate('maya', projectId, { ...proposed.input, operationId: randomUUID(),
    approvalId: approved.receipt.id, expectedSelectionGeneration: proposed.generation + 1 });
  await assert.rejects(tasks.completeTask('maya', pinned.id), { status: 422 });
  assert.equal(event(deniedRoot), undefined);
  assert.equal(event(pinned), undefined);
  await tasks.completeTask('maya', noPolicy.id);
  assert.equal(event(noPolicy), undefined);
  assert.equal(db.prepare('SELECT policy_state FROM team_admissions WHERE source_task_id=?').get(noPolicy.id).policy_state, 'NO_POLICY');
  assert.equal(db.prepare('SELECT revision_id FROM team_admissions WHERE source_task_id=?').get(pinned.id).revision_id, 'old-pinned');
  const existingPersonal = tasks.listProjects('leo').find(p => p.mode === 'PERSONAL');
  await activate('leo', artifacts.personal, undefined, [example(false), noMatch], { confirmOnly: true });
  const oldSelectionTask = await create('leo', existingPersonal.id, 'Keep the selected legacy hook');
  await tasks.completeTask('leo', oldSelectionTask.id);
  assert.equal(event(oldSelectionTask), undefined);
  assert.deepEqual({ ...db.prepare("SELECT revision_id,state FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(oldSelectionTask.id) },
    { revision_id: oldPersonal.revisionId, state: 'PENDING' });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // Exercise the populated schema-20 path separately: shared rows already exist here.
  const pending = await create('maya', projectId, 'Keep the captured shared pin');
  await tasks.completeTask('maya', pending.id);
  const saved = db.prepare('SELECT * FROM shared_completion_events WHERE source_id=?').get(pending.id);
  const root = db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(pending.id);
  assert.equal(saved.state, 'PENDING');
  assert.equal(root.revision_id, proposed.result.revisionId);
  db.exec(`DROP TRIGGER shared_created_update_personal; DROP TRIGGER shared_created_update_team; DROP TRIGGER shared_created_update_edit;
    ${['shared_created_updates', sharedPersonalAdmissionTable, ...sharedBundleTables].map(table => 'DROP TABLE ' + table).join(';')};
    DROP TRIGGER shared_priority_fence_edit; DROP TABLE shared_priority_fences; PRAGMA user_version=20`);
  const reopened = openData(path);
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 24);
    assert.deepEqual(reopened.prepare('SELECT * FROM shared_completion_events WHERE id=?').get(saved.id), saved);
    assert.deepEqual(reopened.prepare('SELECT * FROM team_admissions WHERE event_id=?').get(root.event_id), root);
    assert.equal(reopened.prepare('SELECT count(*) n FROM shared_priority_fences').get().n, 0);
    const reader = createSharedCompletion({ db: reopened, lifecycle: createLifecycle(reopened, { compiler }),
      teamCapability: createTeamCapability(reopened, { compiler }) });
    assert.equal(await reader.run(saved.id), true);
    assert.equal(reader.status('maya', pending.id).receipt.effect, 'CONFIRMED');
    assert.equal(await reader.run(saved.id), false);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { reopened.close(); }
});

test('shared Personal creation still runs the real selected before-save rule', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler }), guard = createTaskCreateGuard({ db, lifecycle, commitReserveMs: 100 });
  const { shared, tasks, project, create, event, activate } = setup(t, db, { guard, cleanup: () => guard.close() });
  const projectId = project('Guarded destination', 'PERSONAL'), otherProjectId = project('Other destination', 'PERSONAL');
  const original = await create('maya', projectId, 'Allow the follow-up');
  const deniedOriginal = await create('maya', otherProjectId, 'Reject the follow-up');
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: 'maya', name: 'Legacy guard' });
  const fixture = taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule: 'project-review',
    projectId: otherProjectId, otherProjectId: projectId });
  let state = await lifecycle.compile('maya', { extensionId, hookId: 'TaskBeforeCreate', draftVersion: 0, source: fixture.source }, () => {});
  const version = () => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await lifecycle.proposeScenarios('maya', { ...version(), cases: fixture.cases }, () => {});
  state = await lifecycle.simulate('maya', version(), () => {});
  assert.equal(state.evidence.passed, true);
  const evidenceId = state.evidence.id;
  lifecycle.approve('maya', { ...version(), evidenceId }, () => {});
  lifecycle.activate('maya', { ...version(), evidenceId, generation: state.selection.generation }, () => {});
  await activate('maya', artifacts.personal);
  await tasks.completeTask('maya', original.id);
  await shared.run(event(original).id);
  assert.equal(shared.status('maya', original.id).receipt?.effect, 'CONFIRMED');
  await tasks.completeTask('maya', deniedOriginal.id);
  await shared.run(event(deniedOriginal).id);
  const denied = shared.status('maya', deniedOriginal.id);
  assert.equal(denied.outcome.error?.code, 'TASK_INVALID');
  assert.deepEqual(denied.outcome.effects.map(effect => effect.state), ['NONE']);
  assert.equal(denied.receipt, null);
});
