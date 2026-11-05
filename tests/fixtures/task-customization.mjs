import assert from 'node:assert/strict';
import { createCompiler } from '../../src/compiler.mjs';
import { loadHost, TASK_HOOK } from '../../src/extension-catalog.mjs';
import { taskEffectSyntax, taskEffectScenarioExamples, validateTaskEffectScenarios } from '../../src/task-effect-simulation.mjs';

// Test programs vary customer constants; production authoring has no rule template.
export function taskCustomizationFixture({ projectId = 'project1', otherProjectId = 'project2', title = 'Example follow-up task' } = {}) {
  assert.ok(typeof projectId === 'string' && projectId.isWellFormed() && projectId);
  assert.ok(typeof otherProjectId === 'string' && otherProjectId.isWellFormed() && otherProjectId && otherProjectId !== projectId);
  assert.ok(typeof title === 'string' && title.isWellFormed() && title.trim() && title.trim().length <= 120);
  title = title.trim();
  const host = loadHost(TASK_HOOK), program = JSON.parse(taskEffectSyntax(host));
  program.name = 'task-customization-fixture';
  program.steps[0].let.literal = projectId;
  program.steps[3].args.title.literal = title;
  const source = JSON.stringify(program, null, 2);
  const cases = taskEffectScenarioExamples(host).map(text => JSON.parse(text));
  for (const row of cases) for (const stub of row.stubs) if (stub.capability === 'tasks.get' && stub.response.kind === 'SUCCESS') {
    stub.response.value.projectId = stub.response.value.projectId === 'project1' ? projectId : otherProjectId;
  }
  for (const row of cases) for (const call of [...row.stubs, ...row.expect.calls]) if (call.capability === 'tasks.create') {
    call.args.projectId = projectId; call.args.title = title;
  }
  validateTaskEffectScenarios(host, cases);
  const wrong = structuredClone(program);
  wrong.steps[2].let.cel = 'source.status == "COMPLETED"';
  const serialized = cases.map(row => JSON.stringify(row, null, 2));
  return { host, source, cases: serialized, metadata: { synthetic: true, offline: true,
    source, wrongSource: JSON.stringify(wrong, null, 2), cases: serialized, projectId, otherProjectId, title } };
}

export async function compileTaskCustomization(options = {}) {
  const fixture = taskCustomizationFixture(options);
  const compiler = createCompiler({ javaExecutable: options.javaExecutable ?? process.env.KEIR_JAVA_BIN });
  const result = await compiler.compile(Buffer.from(fixture.source), { definition: fixture.host });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.artifact instanceof Uint8Array, 'The installed compiler must produce the effect artifact.');
  return { ...fixture, artifactBytes: result.artifact };
}
