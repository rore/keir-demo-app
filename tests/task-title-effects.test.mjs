import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest, json, loadHost, TASK_DEFINITION, TASK_HOOK } from '../src/extension-catalog.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { consumeTaskEffect, taskEffectScenarioExamples, taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const owner = 'sam', authorize = () => {};

function setup(t) {
  const db = openData(':memory:'), native = taskService(db);
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const lifecycle = createLifecycle(db, { compiler });
  let dispatcher;
  t.after(async () => { await dispatcher?.close(); db.close(); });
  return { db, native, lifecycle, projectId: native.listProjects(owner)[0].id,
    dispatch() { dispatcher = createTaskDispatcher({ db, lifecycle }); return dispatcher; } };
}

function ruleAndCases(host, projectId, title) {
  const program = JSON.parse(taskEffectSyntax(host));
  program.steps[0].let.literal = projectId;
  program.steps[3].args.title.literal = title;
  const [match, nonmatch, , missing] = taskEffectScenarioExamples(host).map(text => JSON.parse(text));
  match.stubs[0].response.value.projectId = projectId;
  for (const call of [match.stubs[1], match.expect.calls[1]]) Object.assign(call.args, { projectId, title });
  return { program, match, nonmatch, missing };
}

async function activateCheckedRule({ db, lifecycle, projectId }, host, title) {
  const { program, match } = ruleAndCases(host, projectId, title);
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner });
  let state = await lifecycle.compile(owner, { extensionId, draftVersion: 0, hookId: TASK_HOOK, source: JSON.stringify(program) }, authorize);
  state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion, cases: [JSON.stringify(match)] }, authorize);
  const { revisionId, draftVersion } = state, input = { extensionId, revisionId, draftVersion };
  state = await lifecycle.simulate(owner, input, authorize);
  assert.equal(state.evidence.passed, true);
  const evidenceId = state.evidence.id;
  state = lifecycle.approve(owner, { ...input, evidenceId }, authorize);
  lifecycle.activate(owner, { ...input, generation: state.selection.generation, evidenceId }, authorize);
  const artifact = lifecycle.execution(owner, revisionId, extensionId).artifactBytes;
  const proof = db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(evidenceId).payload;
  const bindingPins = db.prepare('SELECT binding_pins FROM extension_selections WHERE owner_id=? AND hook_id=?').get(owner, TASK_HOOK).binding_pins;
  return { extensionId, revisionId, evidenceId, artifact, proof, bindingPins };
}

test('a checked revision executes queued and new completions and keeps its approval when a draft branches', async t => {
  const fixture = setup(t), { db, native, lifecycle, projectId } = fixture;
  const host = loadHost(TASK_HOOK), title = 'Checked rule follow-up';
  const saved = await activateCheckedRule(fixture, host, title);
  assert.equal(lifecycle.state(owner, saved.extensionId).selection.eligible, true);
  assert.equal(lifecycle.evidence(owner, saved.evidenceId, saved.extensionId).passed, true);
  assert.deepEqual(lifecycle.execution(owner, saved.revisionId, saved.extensionId).artifactBytes, Buffer.from(saved.artifact));

  const complete = label => {
    const source = native.createTask(owner, { projectId, title: label });
    native.completeTask(owner, source.id);
    return source;
  };
  const queued = complete('Queued before the dispatcher starts');
  const event = id => db.prepare('SELECT state,pins FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(id);
  assert.equal(event(queued.id).state, 'PENDING');
  const dispatcher = fixture.dispatch();
  async function checkCompletion(source) {
    await dispatcher.wake();
    const status = dispatcher.status(owner, source.id);
    assert.equal(status.state, 'FINISHED');
    assert.deepEqual(status.outcome.result, { status: 'CREATED' });
    assert.equal(status.receipt.effect, 'CONFIRMED');
    assert.equal(native.getTask(owner, status.receipt.value.id).title, title);
    assert.equal(event(source.id).pins, saved.bindingPins);
  }
  await checkCompletion(queued);
  await checkCompletion(complete('Completed under the retained selection'));

  const selectedPins = JSON.parse(saved.bindingPins);
  const updatePins = db.prepare('UPDATE extension_selections SET binding_pins=? WHERE owner_id=? AND hook_id=?');
  const held = [
    { ...selectedPins, packageIntegrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') },
    { ...selectedPins, definitionId: 'daymark.task-completed/2' },
  ].map(pins => {
    updatePins.run(json(pins), owner, TASK_HOOK);
    try { return complete('Completion with unsupported execution pins'); }
    finally { updatePins.run(saved.bindingPins, owner, TASK_HOOK); }
  });
  await dispatcher.wake();
  await dispatcher.dependenciesChanged();
  for (const source of held) {
    const status = dispatcher.status(owner, source.id);
    assert.equal(status.state, 'PENDING');
    assert.equal(status.outcome, null);
    assert.equal(status.receipt, null);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 2);
  assert.equal(native.listTasks(owner, projectId).filter(task => task.title === title).length, 2);

  const { extensionId, revisionId } = saved;
  const before = lifecycle.state(owner, extensionId);
  const original = lifecycle.source(owner, revisionId, extensionId);
  let draft = lifecycle.restart(owner, { extensionId, revisionId, draftVersion: before.draftVersion, generation: before.selection.generation }, authorize);
  const restartedId = draft.revisionId;
  assert.notEqual(restartedId, revisionId);
  assert.deepEqual(draft.draft.pins, original.pins);
  assert.deepEqual(draft.selection, before.selection);
  assert.equal(draft.approved, false);
  assert.equal(draft.approvedEvidenceId, null);
  assert.equal(draft.evidence, null);

  const scenario = JSON.parse(original.cases[0]);
  scenario.id = 'rechecked-current-model';
  const cases = [JSON.stringify(scenario)];
  draft = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: restartedId, draftVersion: draft.draftVersion, cases }, authorize);
  assert.notEqual(draft.revisionId, restartedId);
  assert.deepEqual(draft.draft.pins, { ...original.pins, suiteDigest: digest(json(cases)) });
  assert.deepEqual(lifecycle.execution(owner, draft.revisionId, extensionId).artifactBytes, Buffer.from(saved.artifact));
  draft = await lifecycle.simulate(owner, { extensionId, revisionId: draft.revisionId, draftVersion: draft.draftVersion }, authorize);
  assert.equal(draft.evidence.passed, true);
  assert.notEqual(draft.evidence.id, saved.evidenceId);
  assert.equal(draft.approved, false);
  assert.equal(draft.approvedEvidenceId, null);
  assert.deepEqual(draft.selection, before.selection);
  assert.equal(db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(saved.evidenceId).payload, saved.proof);
  assert.equal(db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, saved.revisionId).evidence_id, saved.evidenceId);
});

test('a checked title rule copies the exact saved title, skips a different title, and stops at owner and byte boundaries', async t => {
  const fixture = setup(t), { db, native, lifecycle, projectId } = fixture;
  const host = loadHost(TASK_HOOK), model = JSON.parse(host.dcmBytes);
  assert.equal(host.definitionId, TASK_DEFINITION);
  assert.equal(host.definitionId, 'daymark.task-workflow/1');
  assert.equal(model.capabilities['tasks.get'].version, '3');
  const prefix = '界'.repeat(84) + '\0ab';
  const title = prefix + 'X', otherTitle = prefix + 'x', overflowTitle = '界'.repeat(100);
  assert.equal(Buffer.byteLength(title), 256);
  assert.ok(overflowTitle.length <= 120 && Buffer.byteLength(overflowTitle) > 256);
  const foreign = native.createTask('maya', { projectId: native.listProjects('maya')[0].id, title });
  const probe = native.createTask(owner, { projectId, title: 'Check foreign read authorization' });
  const { program, match, nonmatch, missing } = ruleAndCases(host, projectId, title);
  program.steps[1].args.taskId = { cel: 'input.taskId == probeTask ? foreignTask : input.taskId' };
  program.steps[2].let.cel += ` && source.title == ${JSON.stringify(title)}`;
  program.steps[3].args.title = { cel: 'source.title' };
  program.steps.unshift({ id: 'probeTask', let: { literal: probe.id, type: 'TaskId' } },
    { id: 'foreignTask', let: { literal: foreign.id, type: 'TaskId' } });

  match.id = 'exact-title';
  match.stubs[0].response.value.title = title;
  nonmatch.id = 'different-title-case';
  Object.assign(nonmatch.stubs[0].response.value, { projectId, title: otherTitle });
  missing.id = 'foreign-task-denied';
  missing.given.input.taskId = probe.id;
  missing.stubs[0].args.taskId = foreign.id;
  missing.expect.calls[0].args.taskId = foreign.id;
  missing.expect.outcome.error.path = '/steps/3';
  const cases = [match, nonmatch, missing].map(row => {
    const outcome = row.expect.outcome;
    outcome.trace.splice(1, 0, ...['probeTask', 'foreignTask'].flatMap(step => [{ event: 'STEP_START', step }, { event: 'VALUE_BOUND', step }]));
    outcome.trace.forEach((entry, sequence) => { entry.sequence = sequence; });
    row.expect.consumption = consumeTaskEffect(outcome, host);
    return JSON.stringify(row);
  });

  const { extensionId } = admitTaskDraft(db, lifecycle, { owner });
  let state = await lifecycle.compile(owner, { extensionId, draftVersion: 0, hookId: TASK_HOOK, source: JSON.stringify(program) }, authorize);
  state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion, cases }, authorize);
  const input = { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion };
  state = await lifecycle.simulate(owner, input, authorize);
  const proof = lifecycle.evidence(owner, state.evidence.id, extensionId);
  assert.equal(proof.passed, true, JSON.stringify(proof.reports.map(row => row.report.mismatches)));
  const artifactDigest = state.draft.pins.artifactDigest;
  assert.equal(proof.identity.dependencies.artifactDigest, artifactDigest);
  state = lifecycle.approve(owner, { ...input, evidenceId: state.evidence.id }, authorize);
  assert.equal(state.selection.revision, null);
  state = lifecycle.activate(owner, { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, authorize);
  assert.equal(state.selection.revision.id, input.revisionId);

  const matching = native.createTask(owner, { projectId, title: 'Title before the last saved edit' });
  const different = native.createTask(owner, { projectId, title: otherTitle });
  const overflow = native.createTask(owner, { projectId, title: overflowTitle });
  assert.equal(native.getTask(owner, overflow.id).title, overflowTitle);
  assert.throws(() => native.completeTask('maya', matching.id), { status: 404 });
  const before = db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  for (const task of [matching, different, probe, overflow]) native.completeTask(owner, task.id);
  native.editTask(owner, matching.id, { title, notes: '' });
  const dispatcher = fixture.dispatch();
  await dispatcher.wake();

  const status = id => dispatcher.status(owner, id);
  const created = status(matching.id);
  assert.equal(created.state, 'FINISHED');
  assert.equal(created.receipt.effect, 'CONFIRMED');
  assert.equal(native.getTaskForCustomization(owner, created.receipt.value.id).title, title);
  const skipped = status(different.id);
  assert.deepEqual(skipped.outcome.result, { status: 'NO_OP' }, JSON.stringify(skipped));
  assert.equal(status(probe.id).outcome.classification, 'BUSINESS_REJECTION');
  assert.deepEqual(status(probe.id).outcome.error, { code: 'TASK_NOT_FOUND', path: '/steps/3' });
  assert.equal(status(overflow.id).outcome.classification, 'LIMIT_EXCEEDED');
  assert.deepEqual(status(overflow.id).outcome.error, { code: 'BUDGET_EXCEEDED', path: '/steps/3/title' });
  for (const task of [different, probe, overflow]) {
    const result = status(task.id);
    assert.equal(result.state, 'FINISHED');
    assert.deepEqual(result.outcome.effects, []);
    assert.equal(result.receipt, null);
  }
  assert.throws(() => dispatcher.status('maya', matching.id), { status: 404 });
  assert.deepEqual(native.getTask('maya', foreign.id), foreign);
  assert.equal(native.getTaskForCustomization('maya', foreign.id).title, title);
  const events = db.prepare('SELECT revision_id,pins FROM task_events WHERE hook_id=\'TaskCompleted\' AND owner_id=?').all(owner);
  assert.equal(events.length, 4);
  assert.ok(events.every(row => row.revision_id === input.revisionId && JSON.parse(row.pins).artifactDigest === artifactDigest));
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, before + 1);
});

test('a checked suffix rule preserves Unicode and reaches the byte limit before dispatching a write', async t => {
  const fixture = setup(t), { db, native, lifecycle, projectId } = fixture;
  const host = loadHost(TASK_HOOK);
  const title = 'Réparer l’étagère 🧰', suffix = ' — à vérifier';
  const otherTitle = 'réparer l’étagère 🧰', limitTitle = '界'.repeat(85) + 'X';
  const nativeLimitTitle = 'x'.repeat(120);
  const createdTitle = title + suffix;
  assert.equal(Buffer.byteLength(limitTitle), 256);
  assert.ok((limitTitle + suffix).length <= 120 && Buffer.byteLength(limitTitle + suffix) > 256);
  assert.ok((nativeLimitTitle + suffix).length > 120 && Buffer.byteLength(nativeLimitTitle + suffix) <= 256);
  const { program, match, nonmatch } = ruleAndCases(host, projectId, createdTitle);
  program.steps[2].let.cel += ` && source.title != ${JSON.stringify(otherTitle)}`;
  program.steps[3].args.title = { cel: `source.title + ${JSON.stringify(suffix)}` };
  match.id = 'unicode-suffix';
  match.stubs[0].response.value.title = title;
  nonmatch.id = 'different-title-case';
  Object.assign(nonmatch.stubs[0].response.value, { projectId, title: otherTitle });
  const limit = structuredClone(match);
  limit.id = 'suffix-exceeds-runtime-byte-limit';
  limit.stubs[0].response.value.title = limitTitle;
  limit.stubs.length = 1;
  limit.expect.calls.length = 1;
  const trace = limit.expect.outcome.trace.slice(0, limit.expect.outcome.trace.findIndex(row => row.event === 'EFFECT_INTENT'));
  trace.push({ sequence: trace.length, event: 'TERMINATED', code: 'BUDGET_EXCEEDED' });
  const limitError = { code: 'BUDGET_EXCEEDED', path: '/steps/3' };
  limit.expect.outcome = { classification: 'LIMIT_EXCEEDED', error: limitError, effects: [], trace };
  limit.expect.consumption = consumeTaskEffect(limit.expect.outcome, host);
  const cases = [match, nonmatch, limit].map(row => JSON.stringify(row));

  const { extensionId } = admitTaskDraft(db, lifecycle, { owner });
  let state = await lifecycle.compile(owner, { extensionId, draftVersion: 0, hookId: TASK_HOOK, source: JSON.stringify(program) }, authorize);
  state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion, cases }, authorize);
  const input = { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion };
  state = await lifecycle.simulate(owner, input, authorize);
  const proof = lifecycle.evidence(owner, state.evidence.id, extensionId);
  assert.equal(proof.passed, true, JSON.stringify(proof.reports.map(row => ({ id: row.id, report: row.report }))));
  const artifactDigest = digest(lifecycle.execution(owner, input.revisionId, extensionId).artifactBytes);
  assert.equal(proof.identity.dependencies.artifactDigest, artifactDigest);
  assert.deepEqual(proof.reports[0].report.calls[1].args, { projectId, title: createdTitle });
  assert.equal(state.approved, false);
  state = lifecycle.approve(owner, { ...input, evidenceId: proof.id }, authorize);
  assert.equal(state.approvedEvidenceId, proof.id);
  assert.equal(state.selection.revision, null);
  lifecycle.activate(owner, { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, authorize);

  const sources = [title, otherTitle, limitTitle, nativeLimitTitle].map(title => native.createTask(owner, { projectId, title }));
  const before = native.listTasks(owner, projectId).length;
  for (const source of sources) native.completeTask(owner, source.id);
  const dispatcher = fixture.dispatch();
  await dispatcher.wake();
  const [created, skipped, stopped, rejected] = sources.map(source => dispatcher.status(owner, source.id));
  for (const outcome of [created, skipped, stopped, rejected]) assert.equal(outcome.state, 'FINISHED');
  assert.deepEqual(created.outcome.result, { status: 'CREATED' });
  assert.equal(created.receipt.effect, 'CONFIRMED');
  assert.equal(native.getTask(owner, created.receipt.value.id).title, createdTitle);
  assert.deepEqual(skipped.outcome.result, { status: 'NO_OP' });
  assert.equal(stopped.outcome.classification, 'LIMIT_EXCEEDED');
  assert.deepEqual(stopped.outcome.error, limitError);
  for (const outcome of [skipped, stopped]) {
    assert.deepEqual(outcome.outcome.effects, []);
    assert.equal(outcome.receipt, null);
    assert.equal(outcome.outcome.trace.some(row => row.event === 'EFFECT_INTENT' || row.capability === 'tasks.create'), false);
  }
  assert.equal(rejected.outcome.classification, 'BUSINESS_REJECTION');
  assert.deepEqual(rejected.outcome.error, { code: 'TASK_INVALID', path: '/steps/3' });
  assert.deepEqual(rejected.outcome.effects, [{ step: 'created', capability: 'tasks.create', state: 'NONE' }]);
  assert.deepEqual(rejected.receipt, { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
  const events = db.prepare('SELECT revision_id,pins FROM task_events WHERE hook_id=\'TaskCompleted\' AND owner_id=?').all(owner);
  assert.equal(events.length, 4);
  assert.ok(events.every(row => row.revision_id === input.revisionId && JSON.parse(row.pins).artifactDigest === artifactDigest));
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 2);
  assert.equal(native.listTasks(owner, projectId).length, before + 1);
});
