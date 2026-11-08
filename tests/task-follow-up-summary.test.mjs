import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { taskFollowUpSummary } from '../src/web/task-follow-up-summary.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-follow-up-summary.json', import.meta.url)));
const host = loadHost('TaskCompleted'), compiler = createCompiler();
const expected = { titleSuffix: ' - follow up', sameProject: true,
  conditions: [{ field: 'status', value: 'COMPLETED', step: 'source' }] };
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

test('exact captured YAML and equivalent JSON produce the same artifact and follow-up facts', async () => {
  assert.equal(digest(fixture.source), fixture.pins.rawSourceDigest);
  assert.equal(digest(fixture.artifact), fixture.pins.artifactDigest);
  const artifact = await compile(fixture.source);
  assert.deepEqual(artifact, JSON.parse(fixture.artifact));
  assert.equal(artifact.sourceDigest, fixture.pins.compiledSourceDigest);
  assert.deepEqual(await compile(jsonRule()), artifact);
  assert.deepEqual(taskFollowUpSummary(artifact), expected);
});

test('the follow-up recognizer resolves prior let aliases and rejects unsupported dataflow', async () => {
  const aliased = jsonRule();
  aliased.steps.splice(2, 0, { id: 'allowed', let: { cel: 'eligible' } });
  aliased.steps.at(-1).when = 'allowed';
  assert.deepEqual(taskFollowUpSummary(await compile(aliased)), expected);
  for (const change of [
    source => { source.steps[1].let.cel = 'source.status == "OPEN"'; },
    source => { source.steps[1].let.cel = 'source.status != "COMPLETED"'; },
    source => { source.steps[2].args.title.cel = '"follow up " + source.title'; },
    source => { source.steps[2].args.projectId = { literal: 'another-project', type: 'ProjectId' }; },
  ]) {
    const source = jsonRule();
    change(source);
    assert.equal(taskFollowUpSummary(await compile(source)), null);
  }
  for (const change of [
    artifact => { artifact.steps[0].when = 'eligible'; },
    artifact => { artifact.steps[1].value.expr = 'missing'; },
    artifact => { artifact.steps.push({ id: 'extra', op: 'BIND', value: { literal: true } }); },
    artifact => { artifact.expressions.e3.checked = 'invalid'; },
  ]) {
    const artifact = JSON.parse(fixture.artifact);
    change(artifact);
    assert.equal(taskFollowUpSummary(artifact), null);
  }
});
