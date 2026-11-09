import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT, bindModel, prepareProgram } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
export const TASK_HOOK = 'TaskCompleted';
export const TASK_EVENT_HOOKS = Object.freeze(['TaskCreated', TASK_HOOK]);
export const TASK_HOOKS = Object.freeze([...TASK_EVENT_HOOKS, 'TaskBeforeCreate']);
export const TASK_DEFINITION = 'daymark.task-workflow/1';

const archive = 'keir-runtime-node-0.3.0.tgz';
const packageIntegrity = 'sha512-9MJu5RronOfAW78xZ/uj7Y28/1ZkKEz8pNUgqn7O+AsqL/Z3q9tGfbF00q8OUEiD78Ot/HiMhPPhpVuRtAR84w==';
const compiler = 'keir-compiler-java/0.3.0';
const earlierIntegrity = 'sha512-4Rxkk3sbguL7B8e438xEAZiQhmIYul2wvn3ZAAPaKtZsm/6Bpom9UhQGW9IA/zu4VHrtMaX5fM/kWNNeKx6nJg==';
const environment = Object.freeze({ celJava: '0.14.0', celNode: '0.6.1', protobufJava: '4.35.1', protobufNode: '2.6.2' });
const load = path => readFileSync(new URL('../' + path, import.meta.url));

export function readCurrentDefinition(hookId = TASK_HOOK) {
  return readDefinition(hookId, false);
}

function readDefinition(hookId, earlier) {
  const hooks = earlier ? TASK_EVENT_HOOKS : TASK_HOOKS;
  if (!hooks.includes(hookId)) throw new Error('Unsupported host definition');
  const directory = 'extensions/task-effect/' + (earlier ? 'workflow' : 'current');
  const selectedCompiler = earlier ? 'keir-compiler-java/0.2.0' : compiler;
  const selection = JSON.parse(load(directory + '/selection.json'));
  const dcmBytes = load(directory + '/dcm.json'), modelDigest = digest(dcmBytes);
  if (modelDigest !== selection.modelDigest || selectedCompiler !== selection.compiler) throw new Error('Invalid model or compiler selection');
  const model = JSON.parse(dcmBytes), entrypoint = model.entrypoints[hookId];
  if (model.format !== (earlier ? 'keir-dcm/2' : 'keir-dcm/3') || Object.hasOwn(model, 'assurance') || model.domain.id !== 'demo.tasks' || model.domain.version !== (earlier ? '4' : '5')
      || Object.keys(model.entrypoints).length !== hooks.length || hooks.some(id => {
        const entry = model.entrypoints[id];
        if (id === 'TaskBeforeCreate') return entry?.trigger !== 'REQUEST' || entry.placement !== 'BEFORE_COMMIT' || entry.consumer.kind !== 'DECISION' || entry.effectGrant !== 0;
        return entry?.trigger !== 'EVENT' || entry.placement !== 'AFTER_COMMIT' || entry.consumer.kind !== 'EVENT_REPORT';
      }) || model.hostKey.type !== 'demo.TaskWorkflowKey/1') throw new Error('Invalid host hook');

  const modelRef = { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
    digest: modelDigest, descriptorRecipe: 'keir-record-descriptors/2' };
  return { definitionId: TASK_DEFINITION, dcmBytes, catalog: { hooks: [
    { id: 'TaskCreated', label: 'Task added', description: 'React after a task is added', effect: 'WRITE', trigger: 'EVENT' },
    { id: TASK_HOOK, label: 'Task completed', description: 'React after a task is completed', effect: 'WRITE', trigger: 'EVENT' },
    ...(earlier ? [] : [{ id: 'TaskBeforeCreate', label: 'Before a new task is saved', description: 'Check a new task before it is added', effect: 'READ', trigger: 'REQUEST' }]),
  ] },
    pins: { modelDigest, modelRef, definitionId: TASK_DEFINITION, compiler: selectedCompiler, environment,
      packageIntegrity: earlier ? earlierIntegrity : packageIntegrity,
      hook: hookId, consumer: entrypoint.consumer, adapter: earlier ? 'native-task-effect/2' : 'native-task-effect/3' } };
}

export function loadHost(hookId = TASK_HOOK) {
  if (!TASK_HOOKS.includes(hookId) || arguments.length > 1) throw new Error('Unsupported host definition');
  verifyRuntimePackage();
  return readCurrentDefinition(hookId);
}

function verifyRuntimePackage() {
  const runtime = JSON.parse(load('vendor/provenance.json'));
  if (runtime.archive !== archive || runtime.integrity !== packageIntegrity
      || 'sha512-' + createHash('sha512').update(load('vendor/' + archive)).digest('base64') !== packageIntegrity
      || json(environment) !== json(runtime.environment) || json(environment) !== json(ENVIRONMENT)) throw new Error('Invalid runtime package');
}

export function readDefinitionForPins(pins) {
  if (!pins || !TASK_HOOKS.includes(pins.hook) || pins.definitionId !== TASK_DEFINITION || Object.hasOwn(pins, 'profile'))
    throw new Error('Unsupported host definition');
  if (!['keir-dcm/2', 'keir-dcm/3'].includes(pins.modelRef?.format)) throw new Error('Unsupported host definition');
  const host = readDefinition(pins.hook, pins.modelRef.format === 'keir-dcm/2');
  for (const [name, expected] of Object.entries(host.pins)) {
    if (json(pins[name]) !== json(expected)) throw new Error('Host definition mismatch');
  }
  return host;
}

export function definitionForPins(pins) {
  verifyRuntimePackage();
  return readDefinitionForPins(pins);
}

// This adapter only admits bytes. Business operations are bound separately.
export function admitArtifact(artifactBytes, host) {
  const trusted = definitionForPins(host.pins);
  if (digest(host.dcmBytes) !== trusted.pins.modelDigest) throw new Error('Host definition mismatch');
  const artifact = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  if (artifact.entrypoint !== trusted.pins.hook) throw new Error('Artifact trigger mismatch');
  const model = JSON.parse(trusted.dcmBytes);
  const implementations = Object.fromEntries(Object.entries(model.capabilities).map(([id, cap]) => [id, {
    version: cap.version, mode: 'simulation', keyType: model.hostKey.type,
    invoke: async () => { throw new Error('Admission cannot dispatch'); },
  }]));
  const binding = bindModel(trusted.dcmBytes, implementations);
  if (binding.diagnostic) throw new Error('Invalid host model');
  const result = prepareProgram(artifactBytes, binding.boundModel);
  if (result.diagnostic) throw new Error('Invalid authored program');
  return artifact;
}

export function hostBindings(artifactBytes, owner) {
  const artifact = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  return artifact.steps.some(step => step.op === 'CALL') ? { actorId: owner } : {};
}
