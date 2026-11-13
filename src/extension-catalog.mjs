import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT, bindModel, prepareProgram } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
// Cache registered execution definitions, not individual authored revisions.
export const definitionKey = pins => json(Object.fromEntries([
  'modelDigest', 'modelRef', 'definitionId', 'compiler', 'environment', 'packageIntegrity', 'hook', 'consumer', 'adapter',
].map(name => [name, pins?.[name]])));
export const TASK_HOOK = 'TaskCompleted';
export const TASK_EVENT_HOOKS = Object.freeze(['TaskCreated', TASK_HOOK]);
export const TASK_HOOKS = Object.freeze([...TASK_EVENT_HOOKS, 'TaskBeforeCreate']);
export const TASK_DEFINITION = 'daymark.task-workflow/1';

const archive = 'keir-runtime-node-0.5.0.tgz';
const packageIntegrity = 'sha512-tntrT/85XmNV0wmTyW0qG+4BREvsKaBGQt+CF16KssvhhD1sa9TM5I2dzm3TZjJXQ01sdYiPZgnHKFWt4PQ/hA==';
const core040Integrity = 'sha512-BmA7SC7gIYHFmqVlDPcG4Cv51OYRsGRNAImh3AraBZQ2BVhE7YpKIQbkTTSz/wTiZDpIrl1EV9aYxdZ2anDmTw==';
const core031Integrity = 'sha512-LZZjmNa3zeKE+BDqOzFPPXlQcIzeN/Ah8wohvaRjIc1rGh46hPFriL4E4z8sVNvHlYaAlVMd2yffjLR2qTs90g==';
const previousIntegrity = 'sha512-9MJu5RronOfAW78xZ/uj7Y28/1ZkKEz8pNUgqn7O+AsqL/Z3q9tGfbF00q8OUEiD78Ot/HiMhPPhpVuRtAR84w==';
const compiler = 'keir-compiler-java/0.5.0';
const earlierIntegrity = 'sha512-4Rxkk3sbguL7B8e438xEAZiQhmIYul2wvn3ZAAPaKtZsm/6Bpom9UhQGW9IA/zu4VHrtMaX5fM/kWNNeKx6nJg==';
const environment = Object.freeze({ celJava: '0.14.0', celNode: '0.6.1', protobufJava: '4.35.1', protobufNode: '2.6.2' });
const load = path => readFileSync(new URL('../' + path, import.meta.url));

export function readCurrentDefinition(hookId = TASK_HOOK) {
  return readDefinition(hookId, 'numeric');
}

function readDefinition(hookId, generation = 'current') {
  const earlier = generation === 'workflow', previous = generation === 'core-0.3.0', core031 = generation === 'core-0.3.1';
  const numeric = generation === 'numeric', retained = generation === 'retained';
  const hooks = earlier ? TASK_EVENT_HOOKS : TASK_HOOKS;
  if (!hooks.includes(hookId)) throw new Error('Unsupported host definition');
  const directory = 'extensions/task-effect/' + generation;
  const selectedCompiler = earlier ? 'keir-compiler-java/0.2.0' : previous ? 'keir-compiler-java/0.3.0' : core031 ? 'keir-compiler-java/0.3.1'
    : numeric || retained ? compiler : 'keir-compiler-java/0.4.0';
  const selection = JSON.parse(load(directory + '/selection.json'));
  const dcmBytes = load(directory + '/dcm.json'), modelDigest = digest(dcmBytes);
  if (modelDigest !== selection.modelDigest || selectedCompiler !== selection.compiler) throw new Error('Invalid model or compiler selection');
  const model = JSON.parse(dcmBytes), entrypoint = model.entrypoints[hookId];
  if (model.format !== (numeric ? 'keir-dcm/4' : earlier ? 'keir-dcm/2' : 'keir-dcm/3') || Object.hasOwn(model, 'assurance') || model.domain.id !== 'demo.tasks' || model.domain.version !== (numeric ? '6' : earlier ? '4' : '5')
      || Object.keys(model.entrypoints).length !== hooks.length || hooks.some(id => {
        const entry = model.entrypoints[id];
        if (id === 'TaskBeforeCreate') return entry?.trigger !== 'REQUEST' || entry.placement !== 'BEFORE_COMMIT' || entry.consumer.kind !== 'DECISION' || entry.effectGrant !== 0;
        return entry?.trigger !== 'EVENT' || entry.placement !== 'AFTER_COMMIT' || entry.consumer.kind !== 'EVENT_REPORT';
      }) || model.hostKey.type !== 'demo.TaskWorkflowKey/1') throw new Error('Invalid host hook');

  const modelRef = { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
    digest: modelDigest, descriptorRecipe: numeric ? 'keir-record-descriptors/3' : 'keir-record-descriptors/2' };
  return { definitionId: TASK_DEFINITION, dcmBytes, catalog: { hooks: [
    { id: 'TaskCreated', label: 'Task added', description: 'React after a task is added', effect: 'WRITE', trigger: 'EVENT' },
    { id: TASK_HOOK, label: 'Task completed', description: 'React after a task is completed', effect: 'WRITE', trigger: 'EVENT' },
    ...(earlier ? [] : [{ id: 'TaskBeforeCreate', label: 'Before a new task is saved', description: 'Check a new task before it is added', effect: 'READ', trigger: 'REQUEST' }]),
  ] },
    pins: { modelDigest, modelRef, definitionId: TASK_DEFINITION, compiler: selectedCompiler, environment,
      packageIntegrity: earlier ? earlierIntegrity : previous ? previousIntegrity : core031 ? core031Integrity : numeric || retained ? packageIntegrity : core040Integrity,
      hook: hookId, consumer: entrypoint.consumer, adapter: earlier ? 'native-task-effect/2' : 'native-task-effect/3' } };
}

export function loadHost(hookId = TASK_HOOK) {
  if (!TASK_HOOKS.includes(hookId) || arguments.length > 1) throw new Error('Unsupported host definition');
  verifyRuntimePackage();
  return readCurrentDefinition(hookId);
}

// Only these two server-owned definitions may produce new revisions. Old pins remain execution-only.
export function authoringDefinition(hookId, modelDigest) {
  verifyRuntimePackage();
  const candidates = ['numeric', 'retained'].map(generation => readDefinition(hookId, generation));
  const host = modelDigest === undefined ? candidates[0] : candidates.find(item => item.pins.modelDigest === modelDigest);
  if (!host) throw new Error('Unsupported authoring model');
  return host;
}

// Pure format selection from already admitted pins. Never reread deployment files in a native guard.
export function definitionFormats(pins) {
  const format = pins?.modelRef?.format, numeric = format === 'keir-dcm/4';
  const version = pins?.compiler === compiler && ['keir-dcm/3', 'keir-dcm/4'].includes(format) ? '4'
    : pins?.compiler === 'keir-compiler-java/0.2.0' && format === 'keir-dcm/2' ? '2'
      : ['keir-compiler-java/0.3.0', 'keir-compiler-java/0.3.1', 'keir-compiler-java/0.4.0'].includes(pins?.compiler)
        && format === 'keir-dcm/3' ? '3' : null;
  if (!version) throw new Error('Unsupported host format tuple');
  return { source: numeric ? 'keir/3' : 'keir/2', artifact: 'keir-artifact/' + version, scenario: 'keir-scenario/' + version };
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
  if (!['keir-dcm/2', 'keir-dcm/3', 'keir-dcm/4'].includes(pins.modelRef?.format)) throw new Error('Unsupported host definition');
  const generation = pins.modelRef.format === 'keir-dcm/2' && pins.compiler === 'keir-compiler-java/0.2.0' ? 'workflow'
    : pins.modelRef.format === 'keir-dcm/3' && pins.compiler === 'keir-compiler-java/0.3.0' ? 'core-0.3.0'
      : pins.modelRef.format === 'keir-dcm/3' && pins.compiler === 'keir-compiler-java/0.3.1' ? 'core-0.3.1'
        : pins.modelRef.format === 'keir-dcm/3' && pins.compiler === 'keir-compiler-java/0.4.0' ? 'current'
          : pins.modelRef.format === 'keir-dcm/3' && pins.compiler === compiler ? 'retained'
            : pins.modelRef.format === 'keir-dcm/4' && pins.compiler === compiler ? 'numeric' : null;
  if (!generation) throw new Error('Unsupported host definition');
  const host = readDefinition(pins.hook, generation);
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
  if (artifact.compiler !== trusted.pins.compiler) throw new Error('Artifact compiler mismatch');
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
