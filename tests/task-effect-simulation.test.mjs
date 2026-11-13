import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadHost, definitionForPins, admitArtifact, hostBindings, digest, TASK_HOOK, TASK_HOOKS, TASK_DEFINITION } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { consumeTaskEffect, decodeTaskEffectScenarios, preflightTaskEffectScenarios, runTaskEffectSimulation, taskEffectSyntax, taskEffectScenarioExamples } from '../src/task-effect-simulation.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';

const host = loadHost(TASK_HOOK);
const examples = () => taskEffectScenarioExamples(host).map(text => JSON.parse(text));
const invalid = { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' };

test('catalog admits three exact hooks with one current public model', () => {
  assert.equal(host.definitionId, TASK_DEFINITION);
  assert.equal(TASK_DEFINITION, 'daymark.task-workflow/1');
  assert.equal(host.pins.definitionId, TASK_DEFINITION);
  assert.equal(host.pins.modelDigest, digest(host.dcmBytes));
  assert.equal(host.pins.modelRef.digest, host.pins.modelDigest);
  assert.deepEqual(definitionForPins(host.pins).dcmBytes, host.dcmBytes);
  const model = JSON.parse(host.dcmBytes);
  assert.equal(model.format, 'keir-dcm/4');
  assert.ok(!Object.hasOwn(model, 'assurance'));
  assert.equal(model.hostKey.type, 'demo.TaskWorkflowKey/1');
  assert.deepEqual(Object.keys(model.capabilities).sort(), ['tasks.create', 'tasks.get', 'tasks.openMatch', 'tasks.update']);
  assert.equal(model.capabilities['tasks.get'].version, '3');
  assert.deepEqual(Object.keys(model.entrypoints).sort(), [...TASK_HOOKS].sort());
  assert.equal(model.types.Task.fields.title, 'String');
  for (const capability of Object.values(model.capabilities)) assert.equal(capability.parameters.actorId.binding, 'host');
  assert.deepEqual(model.capabilities['tasks.create'].parameters.projectId, { binding: 'agent', type: 'ProjectId' });
  assert.deepEqual(model.capabilities['tasks.create'].parameters.title, { binding: 'agent', type: 'String' });
  assert.deepEqual(model.capabilities['tasks.create'].errors, ['PROJECT_NOT_FOUND', 'ACCESS_DENIED', 'KEY_PAYLOAD_MISMATCH', 'TASK_INVALID']);
  for (const changed of [{ ...host.pins, hook: 'customer-hook' }, { ...host.pins, profile: 'keir-read/2' },
    { ...host.pins, definitionId: 'daymark.task-completed/1' },
    { ...host.pins, hook: 'TaskCreated' },
    { ...host.pins, modelRef: { ...host.pins.modelRef, domainVersion: '1' } }, { ...host.pins, adapter: 'customer-adapter' }])
    assert.throws(() => definitionForPins(changed));
  assert.throws(() => loadHost('customer-hook'));
  assert.throws(() => loadHost(TASK_HOOK, 'daymark.task-completed/2'));
  assert.deepEqual(hostBindings(Buffer.from(JSON.stringify({ steps: [{ op: 'CALL', capability: 'tasks.create' }] })), 'owner'), { actorId: 'owner' });
  assert.deepEqual(hostBindings(Buffer.from(JSON.stringify({ steps: [{ op: 'BIND' }] })), 'owner'), {});
});

test('consumer reports runtime effects and never infers creation from the program label', () => {
  const [match, nonmatch] = examples();
  assert.deepEqual(consumeTaskEffect(match.expect.outcome, host), match.expect.consumption);
  assert.deepEqual(consumeTaskEffect(nonmatch.expect.outcome, host), nonmatch.expect.consumption);
  const falseLabel = structuredClone(nonmatch.expect.outcome);
  falseLabel.result.status = 'CREATED';
  assert.deepEqual(consumeTaskEffect(falseLabel, host).effects, []);
  const failed = structuredClone(match.expect.outcome);
  failed.classification = 'FAILED'; delete failed.result;
  failed.error = { code: 'EXPRESSION_FAILED', path: '/return' }; failed.trace.at(-1).code = failed.error.code;
  assert.equal(consumeTaskEffect(failed, host).effects[0].state, 'CONFIRMED');
  const uncertain = structuredClone(failed);
  uncertain.classification = 'UNCERTAIN'; uncertain.error = { code: 'UNKNOWN_COMMIT', path: '/steps/3' };
  uncertain.effects[0].state = 'UNKNOWN'; uncertain.trace.find(event => event.event === 'EFFECT_RECORDED').state = 'UNKNOWN';
  uncertain.trace.at(-1).code = 'UNKNOWN_COMMIT';
  assert.equal(consumeTaskEffect(uncertain, host).classification, 'UNCERTAIN');
});

test('consumer rejects forged ledgers, invalid outcomes, trace fields and caller authority', () => {
  const [match, nonmatch] = examples();
  const mutate = edit => { const value = structuredClone(match.expect.outcome); edit(value); return value; };
  for (const value of [
    mutate(row => { row.effects = []; }),
    mutate(row => { row.effects[0].state = 'NONE'; }),
    mutate(row => { row.trace.find(item => item.event === 'EFFECT_RECORDED').state = 'NONE'; }),
    mutate(row => { row.trace[0].event = 'RETURNED'; }),
    mutate(row => { row.trace[1].sequence = 0; }),
    mutate(row => { row.trace[1].requestKey = 'private'; }),
    mutate(row => { row.result.extra = true; }),
    mutate(row => { row.error = { code: 'INVALID', path: '/return' }; }),
    mutate(row => { row.classification = 'UNCERTAIN'; }),
    mutate(row => { row.effects.push(row.effects[0]); }),
    mutate(row => { row.trace = row.trace.filter(event => event.event !== 'EFFECT_INTENT').map((event, sequence) => ({ ...event, sequence })); }),
    { ...nonmatch.expect.outcome, extra: true },
  ]) assert.deepEqual(consumeTaskEffect(value, host), invalid);
  let getterCalls = 0;
  const accessor = { ...match.expect.outcome };
  Object.defineProperty(accessor, 'result', { enumerable: true, get() { getterCalls++; return { status: 'CREATED' }; } });
  assert.deepEqual(consumeTaskEffect(accessor, host), invalid);
  assert.equal(getterCalls, 0);
  assert.deepEqual(consumeTaskEffect(match.expect.outcome, { ...host, pins: { ...host.pins, modelDigest: 'sha256:' + '0'.repeat(64) } }), invalid);
});

test('scenario validation closes authority fields, formats, stub shapes, bounds and suite identities before runtime', async () => {
  const [normal, later] = examples(), valid = JSON.stringify(normal);
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const compiled = await compiler.compile(Buffer.from(taskEffectSyntax(host)), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);
  const artifactBytes = compiled.artifact;
  assert.equal((await runTaskEffectSimulation({ artifactBytes, host, scenarios: [valid] })).status, 'PASS');
  const mutate = edit => { const value = structuredClone(later); edit(value); return JSON.stringify(value); };
  for (const row of [
    mutate(row => { row.format = 'keir-scenario/effect-2'; }),
    mutate(row => { row.given.actorId = 'other-owner'; }),
    mutate(row => { row.given.requestKey = 'source-key'; }),
    mutate(row => { row.given.qualification = {}; }),
    mutate(row => { row.given.fixture = '../native'; }),
    mutate(row => { row.given.fixture = 'no-effect-grant'; }),
    mutate(row => { row.given.input.taskId = '\ud800'; }),
    mutate(row => { delete row.given.input.occurredAt; }),
    mutate(row => { row.given.input.occurredAt = '2026-02-30T12:00:00.000Z'; }),
    mutate(row => { row.stubs[0].response.effect = 'CONFIRMED'; }),
    mutate(row => { delete row.stubs[0].response.value.title; }),
    mutate(row => { row.stubs[0].response.value.title = 'a'.repeat(121); }),
    mutate(row => { row.stubs[0].response.value.title = '界'.repeat(120); }),
    mutate(row => { row.stubs[0].response.value.id = 'different-task'; }),
    mutate(row => { row.stubs[0].response.value.status = true; }),
    mutate(row => { row.stubs[0].response.value.tags = ['un-normalized Tag']; }),
    mutate(row => { row.stubs[0].response.value.dueAt = null; }),
    mutate(row => { row.stubs[0].args.sourceTaskId = 'task1'; }),
    mutate(row => { row.stubs[0].protectedArgs.actorId = 'other-owner'; row.expect.calls[0].protectedArgs.actorId = 'other-owner'; }),
    mutate(row => { row.stubs[0].protectedArgs.extra = 'actor'; }),
    mutate(row => { row.expect.calls[0].args.taskId = 'different-task'; }),
    mutate(row => { row.expect.outcome.trace[1].sequence = 2; }),
    mutate(row => { row.expect.consumption.effects = [{ step: 'created', capability: 'tasks.create', state: 'CONFIRMED' }]; }),
    mutate(row => { row.extra = true; }),
    later,
    '\ufeff' + JSON.stringify(later),
    JSON.stringify(later).replace('"id":', '"format":"keir-scenario/1","id":'),
    JSON.stringify(later).replace('"fixture":"normal"', '"fixture":"normal","fixtur\\u0065":"normal"'),
    Buffer.from([255]),
    ' '.repeat(65_537),
  ]) {
    assert.throws(() => preflightTaskEffectScenarios(artifactBytes, host, [valid, row]),
      { caseIndex: 1, code: 'INVALID_SCENARIO' });
    const result = await runTaskEffectSimulation({ artifactBytes, host, scenarios: [valid, row] });
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.mismatches, [{ stage: 'SCENARIO', code: 'INVALID' }]);
    assert.deepEqual(result.reports, []);
  }
  assert.throws(() => preflightTaskEffectScenarios(artifactBytes, host, [valid, valid]),
    { caseIndex: 1, code: 'DUPLICATE_SCENARIO_ID' });
  const duplicate = await runTaskEffectSimulation({ artifactBytes, host, scenarios: [valid, valid] });
  assert.equal(duplicate.status, 'FAIL');
  assert.deepEqual(duplicate.reports, []);
});

test('malformed later raw case rejects before artifact and model admission', () => {
  const [valid] = taskEffectScenarioExamples(host);
  let hostReads = 0;
  const unreadableHost = { get pins() { hostReads++; throw Error('Host was accessed'); } };
  assert.throws(() => preflightTaskEffectScenarios(Buffer.from('{}'), unreadableHost, [valid, '{}']),
    { caseIndex: 1, code: 'INVALID_SCENARIO' });
  assert.equal(hostReads, 0);
});

test('scenario test fixtures vary source constants and preserve independent failure expectations', () => {
  const first = taskCustomizationFixture(), second = taskCustomizationFixture({ projectId: 'project42', title: 'Review the new collection' });
  assert.equal(first.cases.length, 6);
  assert.equal(second.cases.length, 6);
  assert.notEqual(first.source, second.source);
  const a = JSON.parse(first.source), b = JSON.parse(second.source);
  assert.equal(a.steps[0].let.literal, 'project1');
  assert.equal(b.steps[0].let.literal, 'project42');
  assert.equal(b.steps[3].args.title.literal, 'Review the new collection');
  assert.deepEqual(a.steps.filter(item => item.call).map(item => item.call), b.steps.filter(item => item.call).map(item => item.call));
  assert.deepEqual(first.host.pins, second.host.pins);
  const rows = decodeTaskEffectScenarios(second.cases);
  assert.equal(rows[0].expect.calls[1].args.projectId, 'project42');
  assert.equal(rows[0].expect.calls[1].args.title, 'Review the new collection');
  assert.deepEqual(rows.slice(2).map(row => row.expect.outcome.classification), ['COMPLETED', 'BUSINESS_REJECTION', 'BUSINESS_REJECTION', 'FAILED']);
  assert.ok(rows.slice(2).every(row => row.expect.calls.length === 1 && row.expect.outcome.effects.length === 0));
});

test('installed runtime runs exact compiled bytes with independent match/nonmatch and changed source constants', async () => {
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const source = taskEffectSyntax(host);
  const compiled = await compiler.compile(Buffer.from(source), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);
  const artifact = admitArtifact(compiled.artifact, host);
  assert.equal(artifact.format, 'keir-artifact/4');
  for (const changed of [
    { ...artifact, format: 'keir-artifact/1' },
    { ...artifact, format: 'keir-artifact/effect-4' },
    { ...artifact, profile: 'keir-effect/4' },
    { ...artifact, compiler: 'keir-compiler-java/0.0.0' },
    { ...artifact, modelRef: { ...artifact.modelRef, digest: 'sha256:' + '0'.repeat(64) } },
  ]) {
    const failure = await runTaskEffectSimulation({ artifactBytes: Buffer.from(JSON.stringify(changed)), host, scenarios: taskEffectScenarioExamples(host) });
    assert.equal(failure.status, 'FAIL');
    assert.deepEqual(failure.reports, []);
  }
  const base = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: taskEffectScenarioExamples(host) });
  assert.equal(base.status, 'PASS', JSON.stringify(base));
  assert.equal(base.reports[0].report.observed.effect, 'CONFIRMED');
  assert.deepEqual(base.reports[0].report.observed.createdTasks, [{ id: 'task2', projectId: 'project1', title: 'Example follow-up task', tags: [] }]);
  assert.deepEqual(base.reports[1].report.observed, { effect: 'NONE', createdTasks: [], updatedTasks: [] });
  const changed = JSON.parse(source);
  changed.steps[0].let.literal = 'project42'; changed.steps[3].args.title.literal = 'Review the new collection';
  const second = await compiler.compile(Buffer.from(JSON.stringify(changed)), { definition: host });
  assert.deepEqual(second.diagnostics, []);
  assert.notEqual(digest(second.artifact), digest(compiled.artifact));
  const cases = examples();
  cases[0].stubs[0].response.value.projectId = 'project42';
  for (const row of cases) for (const call of [...row.stubs, ...row.expect.calls]) if (call.capability === 'tasks.create') {
    call.args.projectId = 'project42'; call.args.title = 'Review the new collection';
  }
  const other = await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: cases.map(row => JSON.stringify(row)) });
  assert.equal(other.status, 'PASS', JSON.stringify(other));
  const wrongArgs = structuredClone(cases[0]);
  wrongArgs.stubs[1].args.title = wrongArgs.expect.calls[1].args.title = 'Different title';
  const mismatch = await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: [JSON.stringify(wrongArgs)] });
  assert.equal(mismatch.status, 'FAIL');
  assert.ok(mismatch.reports[0].report.mismatches.some(item => item.stage === 'STUB'));
  assert.equal(mismatch.reports[0].report.calls[0].step, 'source');
  const leftover = structuredClone(cases[1]); leftover.stubs.push(cases[0].stubs[1]);
  assert.deepEqual((await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: [JSON.stringify(leftover)] })).reports, []);
  assert.deepEqual(readFileSync(new URL('../extensions/task-effect/numeric/dcm.json', import.meta.url)), host.dcmBytes);
});

test('title-aware simulation matches exactly, preserves the composed title and stops on concatenation overflow', async () => {
  const title = 'ABC' + '界'.repeat(84);
  const differentCase = 'a' + title.slice(1);
  const atLimit = title + 'x';
  assert.equal(Buffer.byteLength(title), 255);
  assert.equal(Buffer.byteLength(atLimit), 256);
  const program = JSON.parse(taskEffectSyntax(host));
  program.steps[2].let.cel += ' && source.title != ' + JSON.stringify(differentCase);
  program.steps[3].args.title = { cel: 'source.title + "x"' };
  const compiled = await createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN })
    .compile(Buffer.from(JSON.stringify(program)), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);

  const [match, nonmatch] = examples();
  match.stubs[0].response.value.title = title;
  match.stubs[1].args.title = atLimit;
  match.expect.calls[1].args.title = atLimit;
  nonmatch.id = 'different-case';
  nonmatch.stubs[0].response.value = { ...match.stubs[0].response.value, title: differentCase };
  const overflow = structuredClone(match);
  overflow.id = 'title-byte-limit';
  overflow.stubs[0].response.value.title = atLimit;
  overflow.stubs.pop();
  overflow.expect.calls.pop();
  const outcome = overflow.expect.outcome;
  outcome.classification = 'LIMIT_EXCEEDED';
  delete outcome.result;
  outcome.effects = [];
  outcome.error = { code: 'BUDGET_EXCEEDED', path: '/steps/3' };
  const intent = outcome.trace.findIndex(event => event.event === 'EFFECT_INTENT');
  outcome.trace = [...outcome.trace.slice(0, intent), { sequence: intent, event: 'TERMINATED', code: outcome.error.code }];
  overflow.expect.consumption = consumeTaskEffect(outcome, host);

  const result = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: [match, nonmatch, overflow].map(row => JSON.stringify(row)) });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [copied, skipped, limited] = result.reports.map(item => item.report);
  assert.deepEqual([copied, skipped, limited].map(report => report.scenario.task.title), [title, differentCase, atLimit]);
  assert.deepEqual(copied.observed.createdTasks, [{ id: 'task2', projectId: 'project1', title: atLimit, tags: [] }]);
  assert.deepEqual(skipped.observed, { effect: 'NONE', createdTasks: [], updatedTasks: [] });
  assert.deepEqual(limited.observed, { effect: 'NONE', createdTasks: [], updatedTasks: [] });
  assert.equal(limited.native.classification, 'LIMIT_EXCEEDED');
  assert.deepEqual(limited.native.error, outcome.error);
  assert.deepEqual(limited.calls.map(call => call.capability), ['tasks.get']);
});

test('installed simulator rejects authority inside reached functions with truthful no effect', async () => {
  const fixture = taskCustomizationFixture();
  const compiled = await createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }).compile(Buffer.from(fixture.source), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);
  const rows = ['invocation-denied', 'invalid-key', 'wrong-origin'].map(kind => {
    const row = fixture.cases.map(text => JSON.parse(text)).find(row => row.id === 'access-denied');
    row.id = kind; row.given.fixture = kind;
    return row;
  });
  const write = examples()[0];
  write.id = 'write-denied'; write.given.fixture = 'write-denied';
  write.stubs[1].response = { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', effect: 'NONE' };
  const outcome = write.expect.outcome;
  outcome.classification = 'BUSINESS_REJECTION'; delete outcome.result;
  outcome.error = { code: 'ACCESS_DENIED', path: '/steps/3' }; outcome.effects[0].state = 'NONE';
  const receipt = outcome.trace.find(event => event.event === 'EFFECT_RECORDED');
  receipt.state = 'NONE';
  outcome.trace = [...outcome.trace.slice(0, receipt.sequence + 1), { sequence: receipt.sequence + 1, event: 'TERMINATED', code: 'ACCESS_DENIED' }];
  write.expect.consumption = consumeTaskEffect(outcome, host);
  const result = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: [...rows, write].map(row => JSON.stringify(row)) });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.ok(result.reports.every(row => row.report.native.classification === 'BUSINESS_REJECTION'));
  assert.deepEqual(result.reports.map(row => row.report.calls.length), [1, 1, 1, 2]);
  assert.ok(result.reports.every(row => row.report.observed.effect === 'NONE'));
});
