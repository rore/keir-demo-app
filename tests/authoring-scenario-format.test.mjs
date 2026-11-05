import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadHost, TASK_HOOK } from '../src/extension-catalog.mjs';
import { authoringExample } from '../src/authoring-example.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const caseIds = ['matching-project', 'other-project', 'unfinished-task', 'missing-task', 'access-denied', 'read-unavailable'];
const title = 'Prepare customer review';
const serialize = cases => cases.map(value => JSON.stringify(value));
const input = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
const rows = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const nativeTables = ['tasks', 'task_completion_events', 'task_effect_receipts', 'extension_selections', 'extension_approvals'];

function setup(t) {
  const db = openData(':memory:');
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const lifecycle = createLifecycle(db, { compiler });
  const native = taskService(db);
  const project = native.createProject('maya', { name: 'Format regression project' });
  const other = native.createProject('maya', { name: 'Other regression project' });
  t.after(() => db.close());
  return { db, lifecycle, project, other };
}

// Adapt the source and independent examples from discovery, never from observed results.
function customerExamples(sourceExample, scenarioExamples, projectId, otherProjectId) {
  const program = JSON.parse(sourceExample);
  program.steps[0].let.literal = projectId;
  program.steps[3].args.title.literal = title;
  const [chosenProject, read, ...later] = program.steps;
  chosenProject.id = 'chosenProject';
  later[0].let.cel = later[0].let.cel.replaceAll('eligibleProject', 'chosenProject');
  later[1].args.projectId.cel = 'chosenProject';
  program.steps = [read, chosenProject, ...later];
  const cases = scenarioExamples.map(text => JSON.parse(text));
  assert.deepEqual(cases.map(value => value.id), caseIds);
  for (const row of cases) {
    for (const call of [...row.stubs, ...row.expect.calls]) {
      if (call.capability === 'tasks.get' && call.response?.kind === 'SUCCESS')
        call.response.value.projectId = call.response.value.projectId === 'project1' ? projectId : otherProjectId;
      if (call.capability === 'tasks.create') { call.args.projectId = projectId; call.args.title = title; }
    }
    const outcome = row.expect.outcome, trace = outcome.trace;
    const readEvents = trace.filter(event => event.step === read.id);
    const projectEvents = trace.filter(event => event.step === 'eligibleProject').map(event => ({ ...event, step: chosenProject.id }));
    const readSucceeded = trace.findIndex(event => event.event === 'CALL_SUCCEEDED' && event.step === read.id);
    outcome.trace = (readSucceeded < 0 ? [trace[0], ...readEvents, trace.at(-1)]
      : [trace[0], ...readEvents, ...projectEvents, ...trace.slice(readSucceeded + 1)]).map((event, sequence) => ({ ...event, sequence }));
    if (outcome.error) {
      outcome.error.path = '/steps/0';
      row.expect.consumption.error.path = '/steps/0';
    }
  }
  return { source: JSON.stringify(program), cases };
}

test('real task scenario admission rejects malformed read-error formats without changing saved authority or independent expectations', async t => {
  const { db, lifecycle, project, other } = setup(t);
  const example = authoringExample(loadHost(TASK_HOOK));
  const desired = customerExamples(example.source, example.cases, project.id, other.id);
  const { extensionId } = admitTaskDraft(db, lifecycle, { name: 'Scenario format regression' });
  let state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, source: desired.source, draftVersion: 0 }, () => {});
  const before = rows(db, [...nativeTables, 'extension_revisions', 'extension_authored', 'extension_evidence']);
  const compiled = lifecycle.source('maya', state.draft.id, extensionId);
  assert.equal(JSON.parse(compiled.source).steps[0].call, 'tasks.get');
  assert.equal(JSON.parse(compiled.source).steps[1].id, 'chosenProject');
  assert.equal(desired.cases[3].expect.outcome.error.path, '/steps/0');
  const malformed = [
    [0, cases => { delete cases[0].expect.outcome.trace; }],
    [3, cases => { cases[3].stubs[0].response = { kind: 'ERROR', error: 'TASK_NOT_FOUND' }; }],
    [3, cases => { cases[3].expect.outcome.error = { code: 'TASK_NOT_FOUND' }; }],
    [3, cases => { cases[3].expect.outcome.classification = 'FAILED'; delete cases[3].expect.outcome.error; }],
    [3, cases => { cases[3].expect.outcome.trace.find(event => event.event === 'CALL_DISPATCHED').event = 'CALL_FAILED'; }],
  ];
  for (const [index, corrupt] of malformed) {
    const cases = structuredClone(desired.cases); corrupt(cases);
    await assert.rejects(lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: serialize(cases) }, () => {}), failure => {
      assert.equal(failure.status, 400);
      assert.deepEqual(failure.diagnostics, [{ code: 'INVALID_SCENARIO', path: `/cases/${index}` }]);
      return true;
    });
    assert.deepEqual(lifecycle.state('maya', extensionId), state);
    assert.deepEqual(lifecycle.source('maya', state.draft.id, extensionId), compiled);
    assert.deepEqual(rows(db, Object.keys(before)), before);
  }
  state = await lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: serialize(desired.cases) }, () => {});
  state = await lifecycle.simulate('maya', { extensionId, ...input(state) }, () => {});
  const passed = lifecycle.evidence('maya', state.evidence.id, extensionId);
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.reports.map(value => value.id), caseIds);
  assert.ok(passed.reports.every(value => value.report.status === 'PASS'));
  assert.deepEqual(rows(db, nativeTables), Object.fromEntries(nativeTables.map(table => [table, before[table]])));

  const independent = structuredClone(desired.cases);
  independent[0].expect = structuredClone(independent[1].expect);
  const originalExpectations = serialize(independent);
  state = await lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: originalExpectations }, () => {});
  state = await lifecycle.simulate('maya', { extensionId, ...input(state) }, () => {});
  const mismatch = lifecycle.evidence('maya', state.evidence.id, extensionId);
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.reports[0].report.status, 'FAIL');
  assert.deepEqual(mismatch.reports[0].expected.createdTasks, []);
  assert.equal(mismatch.reports[0].report.observed.effect, 'CONFIRMED');
  assert.ok(mismatch.reports[0].report.mismatches.length > 0);
  assert.deepEqual(lifecycle.source('maya', state.draft.id, extensionId).cases, originalExpectations);
  assert.throws(() => lifecycle.approve('maya', { extensionId, ...input(state), evidenceId: state.evidence.id }, () => {}), { status: 409 });
  assert.deepEqual(rows(db, nativeTables), Object.fromEntries(nativeTables.map(table => [table, before[table]])));
});

test('offline authoring checks an exact suffix and repairs scenario syntax without dropping requested examples', async t => {
  const { db, lifecycle, project, other } = setup(t);
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-format-key' });
  const before = rows(db, nativeTables), calls = [];
  const suffix = ' – 🧪', expectedTitle = 'Re\u0301sumé 🚀 – 🧪';
  const overflowTitle = 'A' + '界'.repeat(85), overflowId = 'suffix-overflow';
  const suffixCaseIds = [...caseIds, overflowId];
  assert.equal(Buffer.byteLength(overflowTitle), 256);
  assert.ok(Buffer.byteLength(overflowTitle + suffix) > 256);
  assert.ok((overflowTitle + suffix).length <= 120);
  assert.notEqual(expectedTitle, expectedTitle.normalize());
  let desired, independent, compiled, extensionId;
  const service = createAuthoringService({ db, lifecycle, config, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), index = calls.length;
    assert.equal(body.tools.some(value => /approve|activate|select/.test(value.name)), false);
    const output = body.input.filter(value => value.type === 'function_call_output').at(-1);
    const result = output ? JSON.parse(output.output) : null;
    let name, args;
    if (index === 0) {
      assert.match(body.instructions, /source\.title \+ " – follow-up"/);
      assert.match(body.instructions, /exceeds 256 UTF-8 bytes after concatenation/);
      name = 'discover_catalog'; args = {};
    } else if (index === 1) {
      assert.equal(result.ok, true);
      const discovery = result.result;
      assert.equal(discovery.dcm.capabilities['tasks.get'].version, '2');
      assert.equal(discovery.dcm.types.Task.fields.title, 'String');
      assert.match(discovery.businessContext.supported, /append a fixed suffix/);
      assert.ok(discovery.projects.projects.some(value => value.id === project.id));
      assert.ok(discovery.projects.projects.some(value => value.id === other.id));
      desired = customerExamples(discovery.sourceExample, discovery.scenarioExamples, project.id, other.id);
      const program = JSON.parse(desired.source), createStep = program.steps.findIndex(step => step.call === 'tasks.create');
      program.steps[createStep].args.title = { cel: 'source.title + ' + JSON.stringify(suffix) };
      desired.source = JSON.stringify(program);

      const [matching] = desired.cases;
      matching.stubs[0].response.value.title = 'Re\u0301sumé 🚀';
      matching.stubs[1].args.title = expectedTitle;
      matching.expect.calls[1].args.title = expectedTitle;
      const overflow = structuredClone(matching);
      overflow.id = overflowId;
      overflow.stubs[0].response.value.title = overflowTitle;
      overflow.stubs.pop();
      const trace = overflow.expect.outcome.trace.slice(0, overflow.expect.outcome.trace.findIndex(event => event.event === 'EFFECT_INTENT'));
      const error = { code: 'BUDGET_EXCEEDED', path: `/steps/${createStep}` };
      trace.push({ sequence: trace.length, event: 'TERMINATED', code: error.code });
      overflow.expect.calls.pop();
      overflow.expect.outcome = { classification: 'LIMIT_EXCEEDED', error, effects: [], trace };
      overflow.expect.consumption = { status: 'REPORTED', classification: 'LIMIT_EXCEEDED', error, effects: [] };
      desired.cases.push(overflow);
      independent = serialize(desired.cases);
      name = 'compile_draft'; args = { hookId: TASK_HOOK, sourceJson: desired.source, expectedDraftVersion: discovery.currentDraft.draftVersion };
    } else if (index === 2) {
      assert.equal(result.ok, true); compiled = result.result;
      extensionId = db.prepare('SELECT extension_id FROM extension_conversation_links WHERE conversation_id=(SELECT id FROM authoring_conversations WHERE creation_operation_id=?)').get('scenario-format-recovery').extension_id;
      const cases = structuredClone(desired.cases); delete cases[0].expect.outcome.trace;
      name = 'propose_scenarios'; args = { revisionId: compiled.revisionId, cases: serialize(cases), expectedDraftVersion: compiled.draftVersion };
    } else if (index === 3 || index === 4) {
      assert.deepEqual(result, { ok: true, result: { diagnostics: [{ code: 'INVALID_SCENARIO', path: index === 3 ? '/cases/0' : '/cases/3' }] } });
      const state = lifecycle.state('maya', extensionId);
      assert.equal(state.draft.id, compiled.revisionId); assert.equal(state.draftVersion, compiled.draftVersion);
      assert.equal(state.draft.suiteDigest, null); assert.equal(state.approved, false);
      assert.deepEqual(rows(db, nativeTables), before);
      const cases = structuredClone(desired.cases);
      if (index === 3) cases[3].stubs[0].response = { kind: 'ERROR', error: 'TASK_NOT_FOUND' };
      else assert.deepEqual(serialize(cases), independent, 'Format repair must retain every original independent expectation.');
      name = 'propose_scenarios'; args = { revisionId: compiled.revisionId, cases: serialize(cases), expectedDraftVersion: compiled.draftVersion };
    } else if (index === 5) {
      assert.equal(result.ok, true);
      assert.notEqual(result.result.revisionId, compiled.revisionId);
      assert.equal(result.result.draftVersion, compiled.draftVersion + 1);
      name = 'simulate_draft'; args = { revisionId: result.result.revisionId, expectedDraftVersion: result.result.draftVersion };
    } else if (index === 6) {
      assert.equal(result.ok, true);
      const { cases } = result.result.summary;
      assert.deepEqual(cases.map(value => value.id), suffixCaseIds);
      assert.ok(cases.every(value => value.status === 'PASS'));
      assert.equal(cases[0].actual.observed.createdTasks[0].title, expectedTitle);
      assert.equal(cases.at(-1).actual.native.classification, 'LIMIT_EXCEEDED');
      assert.deepEqual(cases.at(-1).actual.observed, { effect: 'NONE', createdTasks: [] });
      name = 'offer_review'; args = { summary: 'The examples confirmed the exact follow-up title and no creation when a title exceeds the size limit. Your tasks have not changed.' };
    } else assert.fail('The local protocol script must not add a paid request or discard a case.');
    calls.push(name);
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', id: `format-reason-${index}`, encrypted_content: 'synthetic-private-reasoning', summary: [] },
      { type: 'function_call', call_id: `format-call-${index}`, name, arguments: JSON.stringify(args) },
    ], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => service.close());
  const started = await service.turn('maya', { conversationId: null, operationId: 'scenario-format-recovery', expectedVersion: 0, expectedDraftVersion: 0,
    target: { kind: 'create' }, text: 'In Format regression project, create a follow-up after completion using the completed task title plus " – 🧪". Check matching, other-project, unfinished, missing, denied, transient-read and oversized result cases. Keep every requested example.' },
  { sessionId: 'format-regression-session', current: () => true });
  const settled = await service.wait('maya', started.conversation.id);
  assert.equal(settled.status, 'REVIEW_AVAILABLE', JSON.stringify(settled));
  assert.equal(settled.review.eligible, true);
  assert.deepEqual(calls, ['discover_catalog', 'compile_draft', 'propose_scenarios', 'propose_scenarios', 'propose_scenarios', 'simulate_draft', 'offer_review']);
  const state = lifecycle.state('maya', extensionId);
  assert.equal(state.approved, false);
  assert.equal(state.evidence.id, settled.review.evidenceId);
  assert.equal(state.evidence.passed, true);
  const overflow = lifecycle.evidence('maya', state.evidence.id, extensionId).reports.at(-1).report;
  assert.deepEqual(overflow.native.error, { code: 'BUDGET_EXCEEDED', path: '/steps/3' });
  assert.deepEqual(overflow.calls.map(call => call.capability), ['tasks.get']);
  assert.deepEqual(overflow.native.effects, []);
  assert.deepEqual(lifecycle.source('maya', state.draft.id, extensionId).cases, independent);
  assert.deepEqual(rows(db, nativeTables), before);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, config.reserveMicros * calls.length);

  const selection = { extensionId, ...input(state) };
  const approved = lifecycle.approve('maya', { ...selection, evidenceId: settled.review.evidenceId }, () => {});
  lifecycle.activate('maya', { ...selection, generation: approved.selection.generation }, () => {});
  const native = taskService(db);
  const source = native.createTask('maya', { projectId: project.id, title: 'Re\u0301sumé 🚀' });
  native.completeTask('maya', source.id);
  const dispatcher = createTaskDispatcher({ db, lifecycle });
  await dispatcher.wake();
  const saved = dispatcher.status('maya', source.id);
  await dispatcher.close();
  assert.equal(saved.receipt.effect, 'CONFIRMED');
  assert.equal(native.getTask('maya', saved.receipt.value.id).title, expectedTitle);
  assert.equal(db.prepare('SELECT revision_id FROM task_completion_events WHERE source_task_id=?').get(source.id).revision_id, state.draft.id);
});
