import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost, readDefinitionForPins } from '../src/extension-catalog.mjs';
import { taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { taskRuleDescription } from '../src/task-rule-description.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-follow-up-summary.json', import.meta.url)));
const host = loadHost('TaskCompleted'), compiler = createCompiler();
const expected = { coverage: 'complete', hook: 'TaskCompleted',
  conditions: [{ field: 'status', value: 'COMPLETED', step: 'source' }],
  action: { capability: 'tasks.create', step: 'created', target: 'newTask', fields: {
    projectId: { kind: 'taskField', step: 'source', field: 'projectId' },
    title: { kind: 'title', step: 'source', suffix: ' - follow up' },
  } } };
const capturedArtifact = JSON.parse(fixture.artifact);
const capturedHost = readDefinitionForPins({ ...host.pins, compiler: capturedArtifact.compiler,
  modelDigest: capturedArtifact.modelRef.digest, modelRef: capturedArtifact.modelRef, adapter: 'native-task-effect/2',
  packageIntegrity: 'sha512-4Rxkk3sbguL7B8e438xEAZiQhmIYul2wvn3ZAAPaKtZsm/6Bpom9UhQGW9IA/zu4VHrtMaX5fM/kWNNeKx6nJg==' });
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
function jsonRule() {
  const source = JSON.parse(taskEffectSyntax(host));
  source.name = 'create-follow-up-after-completion';
  source.steps = [
    { id: 'source', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
    { id: 'eligible', let: { cel: 'source.status == "COMPLETED"' } },
    { id: 'created', call: 'tasks.create', when: 'eligible',
      args: { projectId: { cel: 'source.projectId' }, title: { cel: 'source.title + " - follow up"' } } },
  ];
  source.return.record.status.cel = 'eligible ? "CREATED" : "NO_OP"';
  return source;
}
async function compile(source) {
  const result = await compiler.compile(Buffer.from(typeof source === 'string' ? source : JSON.stringify(source)), { definition: host });
  assert.deepEqual(result.diagnostics, []);
  return JSON.parse(Buffer.from(result.artifact).toString());
}

test('captured YAML retains its original proof while current YAML and JSON produce the same follow-up facts', async () => {
  assert.equal(digest(fixture.source), fixture.pins.rawSourceDigest);
  assert.equal(digest(fixture.artifact), fixture.pins.artifactDigest);
  const captured = JSON.parse(fixture.artifact);
  assert.equal(captured.sourceDigest, fixture.pins.compiledSourceDigest);
  assert.deepEqual(taskRuleDescription(captured, capturedHost), expected);
  const currentSource = fixture.source.replace("version: '4'", "version: '5'")
    .replace(captured.modelRef.digest, host.pins.modelDigest);
  const artifact = await compile(currentSource);
  assert.equal(artifact.format, 'keir-artifact/3');
  assert.deepEqual(await compile(jsonRule()), artifact);
  assert.deepEqual(taskRuleDescription(artifact, host), expected);
});

test('the follow-up recognizer resolves prior let aliases and rejects unsupported dataflow', async () => {
  const aliased = jsonRule();
  aliased.steps.splice(2, 0, { id: 'allowed', let: { cel: 'eligible' } });
  aliased.steps.at(-1).when = 'allowed';
  assert.deepEqual(taskRuleDescription(await compile(aliased), host), expected);
  for (const change of [
    source => { source.steps[1].let.cel = 'source.status != "COMPLETED"'; },
    source => { source.steps[1].let.cel = 'source.status == "COMPLETED" || source.priority == "high"'; },
  ]) {
    const source = jsonRule();
    change(source);
    assert.notEqual(taskRuleDescription(await compile(source), host).coverage, 'complete');
  }
  for (const change of [
    artifact => { artifact.steps[0].when = 'eligible'; },
    artifact => { artifact.steps[1].value.expr = 'missing'; },
    artifact => { artifact.steps.push({ id: 'extra', op: 'BIND', value: { literal: true } }); },
    artifact => { artifact.expressions.e3.checked = 'invalid'; },
  ]) {
    const artifact = JSON.parse(fixture.artifact);
    change(artifact);
    assert.notEqual(taskRuleDescription(artifact, capturedHost).coverage, 'complete');
  }
});
