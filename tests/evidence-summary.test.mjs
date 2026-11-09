import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceSummary } from '../src/authoring-example.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { runTaskEffectSimulation, taskEffectExpected, taskEffectObservationMatches, taskEffectScenarioExamples } from '../src/task-effect-simulation.mjs';
import { taskWorkflowCases, taskWorkflowSource } from './fixtures/task-workflow-source.mjs';

function example(id = 'example', { effect = 'NONE', classification = 'COMPLETED', code, guard, updatedTasks = [] } = {}) {
  const fixture = guard ? taskEffectScenarioExamples(loadHost('TaskBeforeCreate'))
    : taskWorkflowCases(loadHost('TaskCreated'), 'missing-due', { taskId: 'example-task', occurredAt: '2026-12-31T23:00:00.000Z' });
  const index = guard ? { ALLOWED: 0, DENIED: 1, BLOCKED: 3 }[guard]
    : effect === 'CONFIRMED' || effect === 'UNKNOWN' || classification === 'BUSINESS_REJECTION' ? 0 : classification === 'FAILED' ? 3 : 2;
  const scenario = JSON.parse(fixture[index]); scenario.id = id;
  if (!guard && updatedTasks.length) {
    const { id: taskId, ...args } = updatedTasks[0];
    scenario.stubs[1].args = args; scenario.expect.calls[1].args = structuredClone(args);
  }
  if (!guard && (effect === 'UNKNOWN' || classification === 'BUSINESS_REJECTION')) {
    const native = scenario.expect.outcome, state = effect === 'UNKNOWN' ? 'UNKNOWN' : 'NONE';
    scenario.given.fixture = effect === 'UNKNOWN' ? 'lost-response' : 'normal';
    native.classification = classification;
    delete native.result;
    native.error = { code, path: '/steps/2' }; native.effects[0].state = state;
    const receipt = native.trace.findIndex(row => row.event === 'EFFECT_RECORDED');
    native.trace[receipt].state = state;
    native.trace = [...native.trace.slice(0, receipt + 1), { sequence: receipt + 1, event: 'TERMINATED', code }];
    if (state === 'NONE') scenario.stubs[1].response = { kind: 'BUSINESS_REJECTION', code, effect: 'NONE' };
    scenario.expect.consumption = { status: 'REPORTED', classification, error: native.error, effects: native.effects };
  }
  const expected = taskEffectExpected(scenario), { given, stubs, expect } = scenario;
  const observed = { effect: guard ? 'NONE' : effect, createdTasks: expected.createdTasks, updatedTasks: expected.updatedTasks };
  if (effect === 'NOT_OBSERVED') Object.assign(observed, { createdTasks: null, updatedTasks: null });
  const row = { id, label: id, expected: structuredClone(expected), report: {
    status: 'PASS', native: structuredClone(expect.outcome), consumption: structuredClone(expect.consumption),
    calls: structuredClone(expect.calls), observed, mismatches: [], scenario: guard ? { proposal: structuredClone(given.input) }
      : { occurredAt: given.input.occurredAt, task: structuredClone(stubs[0].response.kind === 'SUCCESS'
        ? stubs[0].response.value : { id: given.input.taskId, title: 'Example task' }), openMatches: [] },
  } };
  return { original: JSON.stringify(scenario), row };
}
const summarize = ({ row, original }) => evidenceSummary({ reports: [row] }, [original]);
const facts = row => [row.verification, row.availability, row.outcome];

test('compact authoring evidence preserves all bounded facts and coverage while omitting UI-derived duplicates', () => {
  const samples = [example('changed', { effect: 'CONFIRMED', updatedTasks: [{ id: 'example-task', dueAt: '2027-01-07T23:00:00Z' }] }),
    example('read-unavailable', { classification: 'FAILED', code: 'ADAPTER_TRANSIENT' }),
    example('unknown', { effect: 'UNKNOWN', classification: 'UNCERTAIN', code: 'ADAPTER_EXCEPTION' })];
  const proof = { reports: samples.map(item => item.row) }, originals = samples.map(item => item.original);
  const detailed = evidenceSummary(proof, originals), compact = evidenceSummary(proof, originals, { presentation: false });
  const { counts, statuses, ...expected } = detailed;
  expected.cases = expected.cases.map(({ verification, availability, outcome, label, taskStatus, readFailure, ...facts }) => facts);
  assert.deepEqual(compact, expected);
  assert.equal(compact.cases[1].actual.native.error.code, 'ADAPTER_TRANSIENT');
  assert.equal(compact.cases[2].actual.observed.effect, 'UNKNOWN');
  assert.equal(compact.cases.length, originals.length);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(detailed)));
  const labeled = example('identity');
  Object.assign(labeled.row, { label: 'A distinct supplied label', taskStatus: 'OPEN', readFailure: 'ADAPTER_TRANSIENT' });
  const [retained] = evidenceSummary({ reports: [labeled.row] }, [labeled.original], { presentation: false }).cases;
  assert.equal(retained.label, 'A distinct supplied label');
  assert.equal(retained.taskStatus, 'OPEN');
  assert.equal(retained.readFailure, 'ADAPTER_TRANSIENT');
});

test('observed update, no-op and expected unavailable read have separate verification and effect facts', () => {
  const update = example('update', { effect: 'CONFIRMED', updatedTasks: [{ id: 'example-task', dueAt: '2027-01-07T23:00:00Z' }] });
  update.row.report.native.result = { status: 'NO_OP' };
  update.row.report.consumption.result = { status: 'NO_OP' };
  update.row.expected.outcome.result = { status: 'NO_OP' };
  update.row.expected.consumption.result = { status: 'NO_OP' };
  const original = JSON.parse(update.original); original.expect.outcome.result = { status: 'NO_OP' };
  original.expect.consumption.result = { status: 'NO_OP' };
  update.original = JSON.stringify(original);
  const noop = example('noop');
  const unavailable = example('read-unavailable', { classification: 'FAILED', code: 'ADAPTER_TRANSIENT' });
  const summary = evidenceSummary({ reports: [update.row, noop.row, unavailable.row] }, [update.original, noop.original, unavailable.original]);
  assert.deepEqual(summary.cases.map(facts), [
    ['matched', 'available', 'changed'], ['matched', 'available', 'unchanged'], ['matched', 'unavailable', 'handled-problem'],
  ]);
  assert.equal(summary.cases[0].actual.observed.updatedTasks[0].dueAt, '2027-01-07T23:00:00Z');
  assert.deepEqual(summary.cases[2].actual.native, { classification: 'FAILED', error: { code: 'ADAPTER_TRANSIENT' } });
  assert.deepEqual(summary.counts.verification, { matched: 3, mismatched: 0, unchecked: 0 });
  assert.equal(summary.counts.outcome['handled-problem'], 1);
  assert.equal(summary.totalCases, 3); assert.equal(summary.returnedCases, 3); assert.equal(summary.truncated, false);
});

test('unexpected failure and behavioral mismatch remain distinct from matched handled problems', () => {
  const failed = example('unexpected');
  failed.row.report.status = 'FAIL';
  failed.row.report.native = { classification: 'FAILED', error: { code: 'ADAPTER_TRANSIENT' } };
  failed.row.report.mismatches = [{ stage: 'OUTCOME', code: 'MISMATCH' }];
  assert.deepEqual(facts(summarize(failed).cases[0]), ['mismatched', 'unavailable', 'mismatch']);
  const mismatch = example('wrong-effect', { effect: 'CONFIRMED', updatedTasks: [{ id: 'example-task', priority: 'high' }] });
  mismatch.row.report.status = 'FAIL';
  mismatch.row.report.mismatches = [{ stage: 'CONSUMPTION', code: 'MISMATCH' }];
  assert.deepEqual(facts(summarize(mismatch).cases[0]), ['mismatched', 'available', 'mismatch']);
  const forgedPass = example('wrong-native');
  forgedPass.row.report.native.classification = 'BUSINESS_REJECTION';
  assert.equal(summarize(forgedPass).cases[0].verification, 'mismatched');
});

test('matched rejected writes retain their own reason and do not imply an unavailable read', () => {
  const rejected = example('write-rejected', { classification: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });
  const row = summarize(rejected).cases[0];
  assert.deepEqual(facts(row), ['matched', 'unavailable', 'handled-problem']);
  assert.deepEqual(row.actual.native.error, { code: 'ACCESS_DENIED' });
  assert.equal(row.readFailure, null);
  assert.deepEqual(row.actual.observed, { effect: 'NONE', createdTasks: [], updatedTasks: [] });
});

test('UNKNOWN never becomes no change, even when expected and matched or mismatched', () => {
  const uncertain = example('lost-response', { classification: 'UNCERTAIN', code: 'ADAPTER_EXCEPTION', effect: 'UNKNOWN' });
  assert.deepEqual(facts(summarize(uncertain).cases[0]), ['matched', 'unknown', 'uncertain']);
  uncertain.row.report.status = 'FAIL';
  uncertain.row.report.mismatches = [{ stage: 'OUTCOME', code: 'MISMATCH' }];
  assert.deepEqual(facts(summarize(uncertain).cases[0]), ['mismatched', 'unknown', 'uncertain']);
  assert.equal(summarize(uncertain).counts.outcome.unchanged, 0);
  assert.deepEqual(summarize(uncertain).cases[0].actual.observed, { effect: 'UNKNOWN', createdTasks: null, updatedTasks: null });
});

test('not observed, setup failures, missing reports and malformed evidence remain unchecked', () => {
  const unobserved = example('unobserved', { effect: 'NOT_OBSERVED' });
  assert.equal(summarize(unobserved).cases[0].outcome, 'unchecked');
  const setup = example('setup');
  setup.row.report.mismatches = [{ stage: 'SETUP', code: 'UNAVAILABLE' }];
  assert.equal(summarize(setup).cases[0].verification, 'unchecked');
  for (const mutate of [row => { delete row.report; }, row => { row.report.mismatches = null; },
    row => { row.report.mismatches = [null]; }, row => { row.report.native = null; },
    row => { row.report.observed = { effect: 'NONE', createdTasks: null, updatedTasks: null }; },
    row => { row.report.observed = { effect: 'CONFIRMED', createdTasks: [], updatedTasks: [] }; },
    row => { row.report.status = 'PENDING'; }]) {
    const invalid = example(); mutate(invalid.row);
    assert.equal(summarize(invalid).cases[0].verification, 'unchecked');
  }
  const absent = evidenceSummary({ reports: [] }, [example().original]);
  assert.equal(absent.totalCases, 1); assert.equal(absent.returnedCases, 0); assert.equal(absent.truncated, true);
  assert.equal(absent.counts.verification.matched, 0);
  assert.deepEqual(evidenceSummary(null, null).cases, []);
  assert.equal(evidenceSummary({ reports: [null] }, ['invalid JSON']).cases[0].outcome, 'unchecked');
});

test('association requires a unique exact case and its own expected outcome, calls and consumption', () => {
  const sample = example();
  for (const originals of [[], ['invalid JSON'], ['null'], ['{"id":"example"}'],
    [sample.original, sample.original], [example('other').original]]) {
    assert.equal(evidenceSummary({ reports: [sample.row] }, originals).cases[0].verification, 'unchecked');
  }
  assert.deepEqual(evidenceSummary({ reports: [sample.row, sample.row] }, [sample.original]).cases.map(row => row.verification), ['unchecked', 'unchecked']);
  for (const key of ['outcome', 'calls', 'consumption']) {
    const invalid = structuredClone(sample);
    invalid.row.expected[key] = key === 'calls' ? [] : {};
    assert.equal(summarize(invalid).cases[0].verification, 'unchecked');
  }
  const reordered = JSON.parse(sample.original);
  reordered.expect.outcome = Object.fromEntries(Object.entries(reordered.expect.outcome).reverse());
  assert.equal(evidenceSummary({ reports: [sample.row] }, [JSON.stringify(reordered)]).cases[0].verification, 'matched');
  for (const mutate of [row => { delete row.given; }, row => { row.given = {}; }, row => { row.given.input = null; },
    row => { delete row.stubs; }, row => { row.stubs = null; }, row => { row.stubs = [{}]; }, row => { row.stubs = []; }]) {
    const invalid = JSON.parse(sample.original); mutate(invalid);
    assert.notEqual(evidenceSummary({ reports: [sample.row] }, [JSON.stringify(invalid)]).cases[0].verification, 'matched');
  }
});

test('real simulation observations and situations must match the independent examples before claiming intended effects', async () => {
  const host = loadHost('TaskCreated'), options = { taskId: 'example-task' };
  const compiled = await createCompiler().compile(taskWorkflowSource(host, 'missing-due', options), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);
  const originals = taskWorkflowCases(host, 'missing-due', options);
  const proof = await runTaskEffectSimulation({ host, artifactBytes: compiled.artifact, scenarios: originals });
  assert.equal(proof.status, 'PASS');
  assert.deepEqual(evidenceSummary(proof, originals).cases.map(row => row.verification), Array(4).fill('matched'));
  for (const [index, mutate] of [
    [0, report => { report.observed.updatedTasks[0].dueAt = '2030-01-01T00:00:00.000Z'; }],
    [2, report => { report.observed = { effect: 'CONFIRMED', createdTasks: [], updatedTasks: [{ id: 'example-task', priority: 'high' }] }; }],
    [0, report => { report.scenario.task.title = 'A different task'; }],
    [0, report => { report.scenario.occurredAt = '2030-01-01T00:00:00.000Z'; }],
    [0, report => { report.scenario.extra = 'not a display annotation'; }],
  ]) {
    const corrupt = structuredClone(proof); mutate(corrupt.reports[index].report);
    const row = evidenceSummary(corrupt, originals).cases[index];
    assert.equal(row.status, 'PASS', 'Raw reported status remains inspectable.');
    assert.equal(row.verification, 'mismatched'); assert.equal(row.outcome, 'mismatch');
    assert.equal(taskEffectObservationMatches(JSON.parse(originals[index]), corrupt.reports[index].report), false);
  }
});

test('display project names stay in projected facts without weakening strict native observation checks', () => {
  const [item] = JSON.parse(readFileSync(new URL('./fixtures/current-task-workflow-reports.json', import.meta.url), 'utf8'));
  const [original] = taskEffectScenarioExamples(loadHost('TaskCompleted')).map(text => text.replace('keir-scenario/3', 'keir-scenario/2'));
  assert.equal(taskEffectObservationMatches(JSON.parse(original), item.report), true);
  item.report.scenario.task.projectName = 'Example source project';
  item.report.observed.createdTasks[0].projectName = 'Example destination project';
  assert.equal(taskEffectObservationMatches(JSON.parse(original), item.report), false);
  const projected = evidenceSummary({ reports: [item] }, [original]).cases[0];
  assert.equal(projected.verification, 'matched');
  assert.equal(projected.scenario.task.projectName, 'Example source project');
  assert.equal(projected.actual.observed.createdTasks[0].projectName, 'Example destination project');
  item.report.observed.createdTasks[0].extra = 'not a display annotation';
  assert.equal(evidenceSummary({ reports: [item] }, [original]).cases[0].verification, 'mismatched');
});

test('before-save ALLOW, DENY and BLOCKED preserve their native meaning without claiming a save', () => {
  for (const [guard, classification, code, outcome] of [
    ['ALLOWED', 'COMPLETED', undefined, 'unchanged'], ['DENIED', 'COMPLETED', undefined, 'unchanged'],
    ['BLOCKED', 'FAILED', 'ADAPTER_TRANSIENT', 'handled-problem'],
  ]) {
    const sample = example(guard, { guard, classification, code });
    const row = summarize(sample).cases[0];
    assert.equal(row.verification, 'matched'); assert.equal(row.outcome, outcome);
    assert.equal(row.actual.consumption.status, guard);
    assert.deepEqual(row.actual.consumption, JSON.parse(sample.original).expect.consumption);
    assert.equal(summarize(sample).counts.outcome.changed, 0);
  }
  const mismatch = example('guard-mismatch', { guard: 'DENIED' });
  mismatch.row.report.consumption = { status: 'ALLOWED', result: { decision: 'ALLOW', message: '' } };
  assert.equal(summarize(mismatch).cases[0].verification, 'mismatched');
});

test('bounds keep counts limited to represented cases and preserve raw evidence', () => {
  const samples = Array.from({ length: 10 }, (_, index) => example('case-' + index));
  samples[0].row.label = '😀'.repeat(140);
  samples[0].row.report.observed.createdTasks = Array.from({ length: 9 }, () => ({ title: 'x'.repeat(140), private: 'hidden' }));
  samples[0].row.report.observed.effect = 'CONFIRMED';
  samples[0].row.report.native.private = 'hidden';
  const proof = { reports: samples.map(item => item.row) }, before = JSON.stringify(proof);
  const summary = evidenceSummary(proof, samples.map(item => item.original));
  assert.equal(summary.totalCases, 10); assert.equal(summary.returnedCases, 8); assert.equal(summary.truncated, true);
  assert.equal(Object.values(summary.counts.verification).reduce((a, b) => a + b), 8);
  assert.equal(Object.values(summary.counts.outcome).reduce((a, b) => a + b), 8);
  assert.equal(Array.from(summary.cases[0].label).length, 128);
  assert.equal(summary.cases[0].actual.observed.createdTasks.length, 8);
  assert.equal(summary.cases[0].actual.observed.createdTasks[0].title.length, 128);
  assert.equal(JSON.stringify(summary).includes('hidden'), false);
  assert.equal(JSON.stringify(proof), before);
});

test('frozen Keir 2 reports and current Keir 3 update observations share the projection', () => {
  const reports = JSON.parse(readFileSync(new URL('./fixtures/current-task-workflow-reports.json', import.meta.url), 'utf8'));
  const originals = taskEffectScenarioExamples(loadHost('TaskCompleted')).map(text => text.replace('keir-scenario/3', 'keir-scenario/2'));
  const historical = evidenceSummary({ reports }, originals);
  assert.equal(historical.cases[0].outcome, 'changed');
  assert.ok(historical.cases.some(row => row.outcome === 'handled-problem' && row.actual.native.error?.code === 'ADAPTER_TRANSIENT'));
  assert.ok(historical.cases.every(row => row.verification === 'matched'));
  const current = summarize(example('current-update', { effect: 'CONFIRMED', updatedTasks: [{ id: 'example-task', addTag: 'review' }] }));
  assert.deepEqual(current.cases[0].actual.observed.updatedTasks, [{ id: 'example-task', addTag: 'review' }]);
  assert.equal(current.cases[0].outcome, 'changed');
  assert.ok(historical.cases[0].actual.observed.createdTasks.length > 0);
});
