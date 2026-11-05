import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadHost, TASK_HOOK } from '../src/extension-catalog.mjs';
import { authoringExample } from '../src/authoring-example.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
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

test('offline native provider repairs scenario syntax from discovered formats while retaining all six requested examples', async t => {
  const { db, lifecycle, project, other } = setup(t);
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-format-key' });
  const before = rows(db, nativeTables), calls = [];
  let desired, independent, compiled, extensionId;
  const service = createAuthoringService({ db, lifecycle, config, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), index = calls.length;
    assert.equal(body.tools.some(value => /approve|activate|select/.test(value.name)), false);
    const output = body.input.filter(value => value.type === 'function_call_output').at(-1);
    const result = output ? JSON.parse(output.output) : null;
    let name, args;
    if (index === 0) { name = 'discover_catalog'; args = {}; }
    else if (index === 1) {
      assert.equal(result.ok, true);
      const discovery = result.result;
      assert.equal(discovery.dcm.capabilities['tasks.get'].version, '2');
      assert.equal(discovery.dcm.types.Task.fields.title, 'String');
      assert.ok(discovery.projects.projects.some(value => value.id === project.id));
      assert.ok(discovery.projects.projects.some(value => value.id === other.id));
      desired = customerExamples(discovery.sourceExample, discovery.scenarioExamples, project.id, other.id);
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
      assert.deepEqual(result.result.summary.cases.map(value => value.id), caseIds);
      assert.ok(result.result.summary.cases.every(value => value.status === 'PASS'));
      name = 'offer_review'; args = { summary: 'All six independently expected examples passed, including unavailable reads. Your tasks have not changed.' };
    } else assert.fail('The local protocol script must not add a paid request or discard a case.');
    calls.push(name);
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', id: `format-reason-${index}`, encrypted_content: 'synthetic-private-reasoning', summary: [] },
      { type: 'function_call', call_id: `format-call-${index}`, name, arguments: JSON.stringify(args) },
    ], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => service.close());
  const started = await service.turn('maya', { conversationId: null, operationId: 'scenario-format-recovery', expectedVersion: 0, expectedDraftVersion: 0,
    target: { kind: 'create' }, text: 'In Format regression project, create Prepare customer review after completion. Check matching, other-project, unfinished, missing, denied and transient-read cases. Keep every requested example.' },
  { sessionId: 'format-regression-session', current: () => true });
  const settled = await service.wait('maya', started.conversation.id);
  assert.equal(settled.status, 'REVIEW_AVAILABLE', JSON.stringify(settled));
  assert.equal(settled.review.eligible, true);
  assert.deepEqual(calls, ['discover_catalog', 'compile_draft', 'propose_scenarios', 'propose_scenarios', 'propose_scenarios', 'simulate_draft', 'offer_review']);
  const state = lifecycle.state('maya', extensionId);
  assert.equal(state.approved, false);
  assert.equal(state.evidence.id, settled.review.evidenceId);
  assert.equal(state.evidence.passed, true);
  assert.deepEqual(lifecycle.source('maya', state.draft.id, extensionId).cases, independent);
  assert.deepEqual(rows(db, nativeTables), before);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, config.reserveMicros * calls.length);
});
