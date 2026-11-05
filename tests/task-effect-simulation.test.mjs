import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadHost, loadCatalog, definitionForPins, historicalDefinitionForPins, admitArtifact, hostBindings, digest, json, TASK_HOOK, TASK_DEFINITION, PREVIOUS_TASK_DEFINITION } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { consumeTaskEffect, runTaskEffectSimulation, validateTaskEffectScenarios, taskEffectSyntax, taskEffectScenarioExamples } from '../src/task-effect-simulation.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';

const host = loadHost(TASK_HOOK);
const examples = () => taskEffectScenarioExamples(host).map(text => JSON.parse(text));
const invalid = { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' };

test('catalog keeps exact legacy definitions and exposes a separate generic effect definition', () => {
  const legacy = loadHost();
  assert.equal(legacy.pins.profile, 'keir-read/2');
  assert.equal(legacy.pins.modelRef, undefined);
  assert.equal(loadCatalog().length, 2);
  assert.equal(admitArtifact(loadCatalog()[0].artifactBytes, legacy).entrypoint, 'ClassifyTask');
  assert.equal(host.definitionId, TASK_DEFINITION);
  assert.equal(TASK_DEFINITION, 'daymark.task-completed/3');
  assert.equal(host.pins.definitionId, TASK_DEFINITION);
  assert.equal(host.pins.profile, 'keir-effect/4');
  assert.equal(host.pins.modelDigest, digest(host.dcmBytes));
  assert.equal(host.pins.modelRef.digest, host.pins.modelDigest);
  assert.deepEqual(definitionForPins(host.pins).dcmBytes, host.dcmBytes);
  const model = JSON.parse(host.dcmBytes);
  assert.equal(model.format, 'keir-dcm/effect-4');
  assert.equal(model.assurance, 'HOST_BOUND_SINGLE_WRITE');
  assert.equal(model.hostKey.type, 'demo.TaskCompletionKey/1');
  assert.deepEqual(Object.keys(model.capabilities).sort(), ['tasks.create', 'tasks.get']);
  assert.equal(model.capabilities['tasks.get'].version, '2');
  assert.equal(model.types.Task.fields.title, 'String');
  for (const capability of Object.values(model.capabilities)) assert.equal(capability.parameters.actorId.binding, 'host');
  assert.deepEqual(model.capabilities['tasks.create'].parameters.projectId, { binding: 'agent', type: 'ProjectId' });
  assert.deepEqual(model.capabilities['tasks.create'].parameters.title, { binding: 'agent', type: 'String' });
  assert.deepEqual(model.capabilities['tasks.create'].errors, ['PROJECT_NOT_FOUND', 'ACCESS_DENIED', 'KEY_PAYLOAD_MISMATCH', 'TASK_INVALID']);
  for (const changed of [{ ...host.pins, hook: 'customer-hook' }, { ...host.pins, profile: 'keir-read/2' },
    { ...host.pins, definitionId: 'daymark.task-completed/1' },
    { ...host.pins, modelRef: { ...host.pins.modelRef, domainVersion: '1' } }, { ...host.pins, adapter: 'customer-adapter' }])
    assert.throws(() => definitionForPins(changed));
  assert.throws(() => loadHost('customer-hook'));
  assert.deepEqual(hostBindings(Buffer.from(JSON.stringify({ steps: [{ op: 'CALL', capability: 'tasks.create' }] })), 'owner'), { actorId: 'owner' });
  assert.deepEqual(hostBindings(Buffer.from(JSON.stringify({ steps: [{ op: 'BIND' }] })), 'owner'), {});
});

test('archived effect3 projection preserves raw compiler bytes without current package admission', () => {
  const source = readFileSync(new URL('./fixtures/task-effect-3/source.json', import.meta.url));
  const bytes = readFileSync(new URL('./fixtures/task-effect-3/artifact.json', import.meta.url)), artifact = JSON.parse(bytes);
  assert.equal(digest(source), 'sha256:986e6ab08858fb77139bbf86ca391969ebcee2ad96da514eba7db051a508cf9f');
  assert.equal(digest(bytes), 'sha256:67393a661db66c1e85cca298794727a2736ebe58f200022bc8c97e60bf19d957');
  assert.equal(artifact.profile, 'keir-effect/3');
  assert.equal(artifact.format, 'keir-artifact/effect-3');
  assert.equal(artifact.sourceDigest, digest(Buffer.from(json(JSON.parse(source)))));
  const pins = { ...host.pins, profile: artifact.profile, modelRef: artifact.modelRef, modelDigest: artifact.modelRef.digest,
    compiler: artifact.compiler, environment: artifact.environment, packageIntegrity: 'saved-package-integrity' };
  delete pins.definitionId;
  const historical = historicalDefinitionForPins(pins);
  assert.equal(historical.definitionId, 'daymark.task-completed/1');
  assert.equal(historical.pins.packageIntegrity, 'saved-package-integrity');
  assert.equal(digest(historical.dcmBytes), artifact.modelRef.digest);
  assert.equal(JSON.parse(historical.dcmBytes).assurance, 'HOST_QUALIFIED_SINGLE_WRITE');
  assert.throws(() => definitionForPins(pins));
  for (const changed of [{ ...pins, modelDigest: host.pins.modelDigest }, { ...pins, profile: 'keir-effect/4' },
    { ...pins, definitionId: TASK_DEFINITION }, { ...pins, consumer: { ...pins.consumer, version: 'other' } }])
    assert.throws(() => historicalDefinitionForPins(changed));
  const outcome = examples()[0].expect.outcome;
  assert.deepEqual(consumeTaskEffect(outcome, historical), consumeTaskEffect(outcome, host));
  assert.deepEqual(consumeTaskEffect(outcome, { ...historical, dcmBytes: host.dcmBytes }), invalid);
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
  const [normal] = examples();
  const mutate = edit => { const value = structuredClone(normal); edit(value); return value; };
  for (const row of [
    mutate(row => { row.format = 'keir-scenario/effect-2'; }),
    mutate(row => { row.given.actorId = 'other-owner'; }),
    mutate(row => { row.given.requestKey = 'source-key'; }),
    mutate(row => { row.given.qualification = {}; }),
    mutate(row => { row.given.fixture = '../native'; }),
    mutate(row => { row.given.fixture = 'no-effect-grant'; }),
    mutate(row => { row.given.input.taskId = '\ud800'; }),
    mutate(row => { row.stubs[0].response.effect = 'CONFIRMED'; }),
    mutate(row => { delete row.stubs[0].response.value.title; }),
    mutate(row => { row.stubs[0].response.value.title = 'a'.repeat(121); }),
    mutate(row => { row.stubs[1].response.effect = 'NONE'; }),
    mutate(row => { row.stubs[1].args.sourceTaskId = 'task1'; }),
    mutate(row => { row.stubs[0].protectedArgs.extra = 'actor'; }),
    mutate(row => { row.expect.outcome.effects = []; }),
    mutate(row => { row.expect.consumption.effects = []; }),
    mutate(row => { row.extra = true; }),
    '\ufeff' + JSON.stringify(normal),
    JSON.stringify(normal).replace('"id":', '"format":"keir-scenario/effect-4","id":'),
    JSON.stringify(normal).replace('"fixture":"normal"', '"fixture":"normal","fixtur\\u0065":"normal"'),
    Buffer.from([255]),
    ' '.repeat(65_537),
  ]) {
    const result = await runTaskEffectSimulation({ artifactBytes: Buffer.from('{}'), host, scenarios: [row] });
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.mismatches, [{ stage: 'SCENARIO', code: 'INVALID' }]);
    assert.deepEqual(result.reports, []);
  }
  const duplicate = await runTaskEffectSimulation({ artifactBytes: Buffer.from('{}'), host, scenarios: [normal, normal] });
  assert.equal(duplicate.status, 'FAIL');
  assert.deepEqual(duplicate.reports, []);
});

test('scenario valid data does not confer effect4 support', async () => {
  assert.deepEqual(validateTaskEffectScenarios(host, taskEffectScenarioExamples(host)), examples());
  const result = await runTaskEffectSimulation({ artifactBytes: Buffer.from('{}'), host, scenarios: taskEffectScenarioExamples(host) });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.identity.profile, 'keir-effect/4');
  assert.equal(result.reports.length, 6);
  assert.ok(result.reports.every(row => row.report.status === 'FAIL' && row.report.mismatches[0].stage === 'SETUP'));
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
  const rows = validateTaskEffectScenarios(second.host, second.cases);
  assert.equal(rows[0].expect.calls[1].args.projectId, 'project42');
  assert.equal(rows[0].expect.calls[1].args.title, 'Review the new collection');
  assert.deepEqual(rows.slice(2).map(row => row.expect.outcome.classification), ['COMPLETED', 'BUSINESS_REJECTION', 'BUSINESS_REJECTION', 'FAILED']);
  assert.ok(rows.slice(2).every(row => row.expect.calls.length === 1 && row.expect.outcome.effects.length === 0));
});

test('installed effect4 runtime runs exact compiled bytes with independent match/nonmatch and changed source constants', async () => {
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const source = taskEffectSyntax(host);
  const compiled = await compiler.compile(Buffer.from(source), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(admitArtifact(compiled.artifact, host).profile, 'keir-effect/4');
  const base = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: taskEffectScenarioExamples(host) });
  assert.equal(base.status, 'PASS', JSON.stringify(base));
  assert.equal(base.reports[0].report.observed.effect, 'CONFIRMED');
  assert.deepEqual(base.reports[0].report.observed.createdTasks, [{ projectId: 'project1', title: 'Example follow-up task' }]);
  assert.deepEqual(base.reports[1].report.observed, { effect: 'NONE', createdTasks: [] });
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
  const other = await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: cases });
  assert.equal(other.status, 'PASS', JSON.stringify(other));
  const wrongStep = structuredClone(cases[0]); wrongStep.stubs[0].step = 'wrongStep';
  const mismatch = await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: [wrongStep] });
  assert.equal(mismatch.status, 'FAIL');
  assert.ok(mismatch.reports[0].report.mismatches.some(item => item.stage === 'STUB'));
  assert.equal(mismatch.reports[0].report.calls[0].step, 'source');
  const leftover = structuredClone(cases[1]); leftover.stubs.push(cases[0].stubs[1]);
  assert.equal((await runTaskEffectSimulation({ artifactBytes: second.artifact, host, scenarios: [leftover] })).status, 'FAIL');
  assert.deepEqual(readFileSync(new URL('../extensions/task-effect/title/dcm.json', import.meta.url)), host.dcmBytes);
});

test('previous task definition still compiles and simulates exact version 1 reads', async () => {
  const previous = loadHost(TASK_HOOK, PREVIOUS_TASK_DEFINITION);
  const scenarios = taskEffectScenarioExamples(previous);
  const [match] = validateTaskEffectScenarios(previous, scenarios);
  assert.equal(match.stubs[0].version, '1');
  assert.deepEqual(match.stubs[0].response.value, { id: 'task1', projectId: 'project1', status: 'COMPLETED' });
  assert.throws(() => validateTaskEffectScenarios(host, scenarios));
  assert.throws(() => validateTaskEffectScenarios(previous, examples()));
  match.stubs[0].response.value.title = 'Example task';
  assert.throws(() => validateTaskEffectScenarios(previous, [match]));
  const compiled = await createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN })
    .compile(Buffer.from(taskEffectSyntax(previous)), { definition: previous });
  assert.deepEqual(compiled.diagnostics, []);
  const result = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host: previous, scenarios });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.reports[0].report.scenario.task.title, 'Example task');
});

test('title-aware simulation matches exactly, copies the full title and stops before writing on byte overflow', async () => {
  const title = 'A' + '界'.repeat(85);
  const differentCase = 'a' + title.slice(1);
  const oversized = '界'.repeat(120);
  assert.equal(Buffer.byteLength(title), 256);
  assert.equal(oversized.length, 120);
  assert.ok(Buffer.byteLength(oversized) > 256);
  const program = JSON.parse(taskEffectSyntax(host));
  program.steps[2].let.cel += ' && source.title == ' + JSON.stringify(title);
  program.steps[3].args.title = { cel: 'source.title' };
  const compiled = await createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN })
    .compile(Buffer.from(JSON.stringify(program)), { definition: host });
  assert.deepEqual(compiled.diagnostics, []);

  const [match, nonmatch, , overflow] = examples();
  match.stubs[0].response.value.title = title;
  match.stubs[1].args.title = title;
  match.expect.calls[1].args.title = title;
  nonmatch.id = 'different-case';
  nonmatch.stubs[0].response.value = { ...match.stubs[0].response.value, title: differentCase };
  overflow.id = 'title-byte-limit';
  overflow.stubs[0].response = { kind: 'SUCCESS', value: { ...match.stubs[0].response.value, title: oversized } };
  const outcome = overflow.expect.outcome;
  outcome.classification = 'LIMIT_EXCEEDED';
  outcome.error = { code: 'BUDGET_EXCEEDED', path: '/steps/1/title' };
  outcome.trace.at(-1).code = outcome.error.code;
  overflow.expect.consumption = consumeTaskEffect(outcome, host);

  const result = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: [match, nonmatch, overflow] });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [copied, skipped, limited] = result.reports.map(item => item.report);
  assert.deepEqual([copied, skipped, limited].map(report => report.scenario.task.title), [title, differentCase, oversized]);
  assert.deepEqual(copied.observed.createdTasks, [{ projectId: 'project1', title }]);
  assert.deepEqual(skipped.observed, { effect: 'NONE', createdTasks: [] });
  assert.deepEqual(limited.observed, { effect: 'NONE', createdTasks: [] });
  assert.equal(limited.native.classification, 'LIMIT_EXCEEDED');
  assert.deepEqual(limited.native.error, outcome.error);
  assert.deepEqual(limited.calls.map(call => call.capability), ['tasks.get']);
});

test('installed effect4 simulator rejects authority inside reached functions with truthful no effect', async () => {
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
  const result = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host, scenarios: [...rows, write] });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.ok(result.reports.every(row => row.report.native.classification === 'BUSINESS_REJECTION'));
  assert.deepEqual(result.reports.map(row => row.report.calls.length), [1, 1, 1, 2]);
  assert.ok(result.reports.every(row => row.report.observed.effect === 'NONE'));
});
