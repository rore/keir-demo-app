import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCompiler } from '../src/compiler.mjs';
import { digest, loadHost, TASK_HOOKS } from '../src/extension-catalog.mjs';
import { decodeKeirScenario } from '../src/keir-scenario.mjs';
import { runTaskEffectSimulation, taskEffectScenarioExamples, taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { taskWorkflowCases, taskWorkflowSource } from './fixtures/task-workflow-source.mjs';

const occurredAt = '2026-03-07T16:00:00.417Z';
const dueAt = '2026-03-14T16:00:00.417Z';
const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });

async function simulate(hook, workflow, options) {
  const host = loadHost(hook);
  const { diagnostics, artifact } = await compiler.compile(taskWorkflowSource(host, workflow, options), { definition: host });
  assert.deepEqual(diagnostics, []);
  const cases = taskWorkflowCases(host, workflow, options);
  const run = scenarios => runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios });
  const result = await run(cases);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  return { reports: result.reports.map(row => row.report), run, cases };
}

test('scenario reader keeps /1 history and admits the exact frozen /2 structure', async () => {
  const path = name => new URL('../vendor/keir-verification/' + name, import.meta.url);
  assert.equal(digest(readFileSync(path('scenario-v2.schema.json'))),
    'sha256:04f7a3d00eb02bc3fdcf7a6387ae84a9995430d9b7b8165eccc204384e9cd9e2');
  assert.equal(decodeKeirScenario(readFileSync(path('scenarios/main/normal.json'))).format, 'keir-scenario/1');
  for (const hook of TASK_HOOKS) {
    const host = loadHost(hook);
    const { diagnostics, artifact } = await compiler.compile(Buffer.from(taskEffectSyntax(host)), { definition: host });
    assert.deepEqual(diagnostics, []);
    const scenarios = taskEffectScenarioExamples(host);
    const result = await runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios });
    assert.equal(result.status, 'PASS', JSON.stringify(result));
    assert.equal(result.reports.length, 6);
    const wrongHost = loadHost(TASK_HOOKS.find(other => other !== hook));
    assert.equal((await runTaskEffectSimulation({ host: wrongHost, artifactBytes: artifact, scenarios })).status, 'FAIL');
    const historical = scenarios[0].replace('keir-scenario/2', 'keir-scenario/1');
    assert.equal(decodeKeirScenario(Buffer.from(historical)).format, 'keir-scenario/1');
    assert.equal((await runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios: [historical] })).status, 'FAIL');
  }
});

test('creation trigger updates priority only on the exact title and tag', async () => {
  const { reports, run, cases } = await simulate('TaskCreated', 'intake', { projectId: 'inbox', title: 'Check quote', taskId: 'incoming-task' });
  assert.deepEqual(reports[0].observed, { effect: 'CONFIRMED', createdTasks: [], updatedTasks: [{ id: 'incoming-task', priority: 'high' }] });
  assert.deepEqual(reports[1].observed, { effect: 'NONE', createdTasks: [], updatedTasks: [] });
  const forged = JSON.parse(cases[0]);
  forged.stubs[1].response.value.id = 'someone-else';
  assert.equal((await run([JSON.stringify(forged)])).mismatches[0].code, 'INVALID');
});

test('completion creates a cross-project review with normalized tags and the exact elapsed due time', async () => {
  const { reports, run, cases } = await simulate('TaskCompleted', 'review',
    { destinationProjectId: 'reviews', reviewTitle: '  Review launch  ', createdTaskId: 'example-review' });
  assert.deepEqual(reports[0].observed.createdTasks, [{ id: 'example-review', projectId: 'reviews', title: 'Review launch', tags: ['review', 'next'], dueAt }]);
  assert.equal(reports[1].observed.effect, 'NONE');
  for (const invalid of ['review,,next', 'é'.repeat(129), 'a,b,c,d,e,f,g,h,i']) {
    const changed = JSON.parse(cases[0]);
    changed.stubs[1].args.tagsText = invalid;
    changed.expect.calls[1].args.tagsText = invalid;
    assert.equal((await run([JSON.stringify(changed)])).mismatches[0].code, 'INVALID');
  }
});

test('completion distinguishes a false exact open-match from a true or unavailable read', async () => {
  const args = { projectId: 'action-items', title: 'Call back' };
  const { reports } = await simulate('TaskCompleted', 'follow-up', { destinationProjectId: args.projectId, followUpTitle: args.title });
  assert.deepEqual(reports.map(report => report.scenario.openMatches), [[{ ...args, matches: false }], [{ ...args, matches: true }], []]);
  assert.deepEqual(reports.map(report => report.observed.effect), ['CONFIRMED', 'NONE', 'NONE']);
  assert.equal(reports[2].native.error.code, 'ADAPTER_TRANSIENT');
});

test('an invalid native open-match cannot simulate a successful false result', async () => {
  const host = loadHost('TaskCompleted'), options = { destinationProjectId: 'a'.repeat(129) };
  const { diagnostics, artifact } = await compiler.compile(taskWorkflowSource(host, 'follow-up', options), { definition: host });
  assert.deepEqual(diagnostics, []);
  const [falseMatch, , unavailable] = taskWorkflowCases(host, 'follow-up', options);
  const failed = await runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios: [falseMatch] });
  assert.equal(failed.status, 'FAIL');
  const matched = await runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios: [unavailable] });
  assert.equal(matched.status, 'PASS');
  assert.equal(matched.reports[0].report.native.error.code, 'ADAPTER_TRANSIENT');
  assert.deepEqual(matched.reports[0].report.scenario.openMatches, []);
});

test('a create title invisible to SQLite cannot simulate a confirmed write', async () => {
  const host = loadHost('TaskCompleted'), options = { reviewTitle: '\u0000review' };
  const { diagnostics, artifact } = await compiler.compile(taskWorkflowSource(host, 'review', options), { definition: host });
  assert.deepEqual(diagnostics, []);
  const [confirmed] = taskWorkflowCases(host, 'review', options);
  const result = await runTaskEffectSimulation({ host, artifactBytes: artifact, scenarios: [confirmed] });
  assert.equal(result.status, 'FAIL');
});

test('creation sets a missing due date without dispatching a write for an existing date', async () => {
  const { reports } = await simulate('TaskCreated', 'onboarding', { projectId: 'onboarding' });
  assert.deepEqual(reports[0].observed.updatedTasks, [{ id: 'task1', dueAt }]);
  assert.deepEqual(reports[1].observed.updatedTasks, []);
  assert.equal(reports[1].scenario.task.dueAt, occurredAt);
});

test('unknown update exposes no observed task identity or change', async () => {
  const { run, cases } = await simulate('TaskCreated', 'onboarding');
  const row = JSON.parse(cases[0]);
  row.given.fixture = 'lost-response';
  const { outcome } = row.expect;
  outcome.classification = 'UNCERTAIN';
  delete outcome.result;
  outcome.error = { code: 'ADAPTER_EXCEPTION', path: '/steps/3' };
  outcome.effects[0].state = 'UNKNOWN';
  outcome.trace.splice(-3, 3, { sequence: outcome.trace.length - 3, event: 'TERMINATED', code: outcome.error.code });
  outcome.trace.at(-2).state = 'UNKNOWN';
  row.expect.consumption = { status: 'REPORTED', classification: outcome.classification, error: outcome.error, effects: outcome.effects };
  const result = await run([JSON.stringify(row)]);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(result.reports[0].report.observed, { effect: 'UNKNOWN', createdTasks: null, updatedTasks: null });
});
