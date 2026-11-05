import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT, bindModel, prepareProgram } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
export const TASK_HOOK = 'TaskCompleted';
export const TASK_DEFINITION = 'daymark.task-completed/3';

const archive = 'keir-runtime-node-0.1.0.tgz';
const packageIntegrity = 'sha512-Mh+aoeEFLsDyMrSF+gJneYYGbiG+qfRpXmERcJi5KRFT7MHltifLeh1t4LNQ1FJ+amThqNAPcNm3chHvV7xDEw==';
const compiler = 'keir-compiler-java/0.1.0';
const environment = Object.freeze({ celJava: '0.14.0', celNode: '0.6.1', protobufJava: '4.35.1', protobufNode: '2.6.2' });
const load = path => readFileSync(new URL('../' + path, import.meta.url));

export function readCurrentDefinition() {
  const selection = JSON.parse(load('extensions/task-effect/title/selection.json'));
  const dcmBytes = load('extensions/task-effect/title/dcm.json'), modelDigest = digest(dcmBytes);
  if (modelDigest !== selection.modelDigest || compiler !== selection.compiler) throw new Error('Invalid model or compiler selection');
  const model = JSON.parse(dcmBytes), entrypoint = model.entrypoints[TASK_HOOK];
  if (model.format !== 'keir-dcm/1' || Object.hasOwn(model, 'assurance') || model.domain.id !== 'demo.tasks' || model.domain.version !== '3'
      || entrypoint?.trigger !== 'EVENT' || entrypoint.placement !== 'AFTER_COMMIT' || entrypoint.consumer.kind !== 'EVENT_REPORT'
      || model.hostKey.type !== 'demo.TaskCompletionKey/1') throw new Error('Invalid host hook');

  const modelRef = { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
    digest: modelDigest, descriptorRecipe: 'keir-record-descriptors/1' };
  return { definitionId: TASK_DEFINITION, dcmBytes, catalog: { hooks: [{ id: TASK_HOOK, label: 'Task completed',
    description: 'React after a task is completed', effect: 'WRITE', trigger: entrypoint.trigger }] },
    pins: { modelDigest, modelRef, definitionId: TASK_DEFINITION, compiler, environment, packageIntegrity,
      hook: TASK_HOOK, consumer: entrypoint.consumer, adapter: 'native-task-effect/1' } };
}

export function loadHost(hookId = TASK_HOOK) {
  if (hookId !== TASK_HOOK || arguments.length > 1) throw new Error('Unsupported host definition');
  const runtime = JSON.parse(load('vendor/provenance.json'));
  if (runtime.archive !== archive || runtime.integrity !== packageIntegrity
      || 'sha512-' + createHash('sha512').update(load('vendor/' + archive)).digest('base64') !== packageIntegrity
      || json(environment) !== json(runtime.environment) || json(environment) !== json(ENVIRONMENT)) throw new Error('Invalid runtime package');
  return readCurrentDefinition();
}

export function definitionForPins(pins) {
  if (!pins || pins.hook !== TASK_HOOK || pins.definitionId !== TASK_DEFINITION || Object.hasOwn(pins, 'profile'))
    throw new Error('Unsupported host definition');
  const host = loadHost();
  for (const [name, expected] of Object.entries(host.pins)) {
    if (json(pins[name]) !== json(expected)) throw new Error('Host definition mismatch');
  }
  return host;
}

// This adapter only admits bytes. Business operations are bound separately.
export function admitArtifact(artifactBytes, host) {
  const trusted = definitionForPins(host.pins);
  if (digest(host.dcmBytes) !== trusted.pins.modelDigest) throw new Error('Host definition mismatch');
  const model = JSON.parse(trusted.dcmBytes);
  const implementations = Object.fromEntries(Object.entries(model.capabilities).map(([id, cap]) => [id, {
    version: cap.version, mode: 'simulation', keyType: model.hostKey.type,
    invoke: async () => { throw new Error('Admission cannot dispatch'); },
  }]));
  const binding = bindModel(trusted.dcmBytes, implementations);
  if (binding.diagnostic) throw new Error('Invalid host model');
  const result = prepareProgram(artifactBytes, binding.boundModel);
  if (result.diagnostic) throw new Error('Invalid authored program');
  return JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
}

export function hostBindings(artifactBytes, owner) {
  const artifact = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  return artifact.steps.some(step => step.op === 'CALL' && ['tasks.get', 'tasks.create'].includes(step.capability)) ? { actorId: owner } : {};
}
