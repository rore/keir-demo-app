import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT, bindModel, prepareProgram } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
export const consumer = Object.freeze({ id: 'demo.taskadvice', version: '1', kind: 'DISPLAY' });
export const hook = 'ClassifyTask';
export const TASK_HOOK = 'TaskCompleted';
export const TASK_DEFINITION = 'daymark.task-completed/2';
const definitions = Object.freeze({
  [hook]: { directory: 'task-read', id: 'daymark.task-read/1', profile: 'keir-read/2', adapter: 'native-task-read/1' },
  [TASK_HOOK]: { directory: 'task-effect', id: TASK_DEFINITION, profile: 'keir-effect/4', adapter: 'native-task-effect/1' },
});

const load = path => readFileSync(new URL('../' + path, import.meta.url));
// Historical projection uses known model bytes, never current package admission.
const historicalModels = [
  { path: 'extensions/task-read/dcm.json', definition: definitions[hook], hook },
  { path: 'extensions/task-effect/dcm.json', definition: definitions[TASK_HOOK], hook: TASK_HOOK },
  { path: 'extensions/task-effect/legacy-3/dcm.json', definition: { ...definitions[TASK_HOOK], id: 'daymark.task-completed/1', profile: 'keir-effect/3' }, hook: TASK_HOOK },
].flatMap(item => {
  try {
    const bytes = load(item.path), model = JSON.parse(bytes), task = item.hook === TASK_HOOK, modelDigest = digest(bytes);
    const expected = { hook: item.hook, profile: item.definition.profile, modelDigest,
      consumer: task ? model.entrypoints[TASK_HOOK].consumer : consumer, adapter: item.definition.adapter,
      ...(task ? { modelRef: { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
        digest: modelDigest, descriptorRecipe: 'keir-record-descriptors/1' } } : {}) };
    return [{ ...item, bytes, expected }];
  } catch { return []; }
});
export function historicalDefinitionForPins(pins) {
  const known = historicalModels.find(item => item.hook === pins?.hook && item.definition.profile === pins.profile && item.expected.modelDigest === pins.modelDigest);
  if (!known) throw new Error('Unsupported historical definition');
  for (const [name, value] of Object.entries(known.expected)) if (json(pins[name]) !== json(value)) throw new Error('Historical definition mismatch');
  if (pins.definitionId !== undefined && pins.definitionId !== known.definition.id
      || known.definition.profile === 'keir-effect/4' && pins.definitionId !== TASK_DEFINITION) throw new Error('Historical definition mismatch');
  return { definitionId: known.definition.id, dcmBytes: Buffer.from(known.bytes), pins: JSON.parse(json(pins)) };
}
export function loadHost(hookId = hook) {
  if (!Object.hasOwn(definitions, hookId)) throw new Error('Unsupported host definition');
  const definition = definitions[hookId];
  const pins = JSON.parse(load(`extensions/${definition.directory}/selection.json`));
  const task = hookId === TASK_HOOK;
  const runtime = task ? JSON.parse(load('vendor/provenance.json')) : pins.runtime;
  if (!runtime || typeof runtime.archive !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(runtime.integrity)) throw new Error('Invalid runtime package');
  const archive = load(task ? 'vendor/' + runtime.archive : runtime.archive);
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== runtime.integrity) throw new Error('Invalid runtime package');
  const dcmBytes = load(`extensions/${definition.directory}/dcm.json`);
  if (digest(dcmBytes) !== pins.modelDigest) throw new Error('Invalid model');
  const model = JSON.parse(dcmBytes);
  const entrypoint = model.entrypoints[hookId];
  if (!entrypoint || task && (model.format !== 'keir-dcm/effect-4' || model.assurance !== 'HOST_BOUND_SINGLE_WRITE'
      || entrypoint.trigger !== 'EVENT' || entrypoint.placement !== 'AFTER_COMMIT' || entrypoint.consumer.kind !== 'EVENT_REPORT'
      || model.hostKey.type !== 'demo.TaskCompletionKey/1')
      || !task && (entrypoint.trigger !== 'REQUEST' || Object.values(model.capabilities).some(item => item.effect !== 'READ'))) throw new Error('Invalid host hook');
  const modelRef = { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
    digest: pins.modelDigest, descriptorRecipe: 'keir-record-descriptors/1' };
  return { definitionId: definition.id, dcmBytes, catalog: { hooks: [{ id: hookId,
    label: task ? 'Task completed' : 'Task status advice',
    description: task ? 'React after a task is completed' : 'Show advice when checking a saved task',
    effect: task ? 'WRITE' : 'READ', trigger: entrypoint.trigger }] }, programs: pins.programs,
    pins: { modelDigest: pins.modelDigest, ...(task ? { modelRef, definitionId: definition.id } : {}), compiler: pins.compiler, environment: task ? ENVIRONMENT : runtime.environment,
      profile: definition.profile, hook: hookId, consumer: task ? entrypoint.consumer : consumer,
      packageIntegrity: runtime.integrity, adapter: definition.adapter } };
}

export function definitionForPins(pins) {
  if (!pins || !Object.hasOwn(definitions, pins.hook)) throw new Error('Unsupported host definition');
  const host = loadHost(pins.hook);
  for (const [name, expected] of Object.entries(host.pins)) {
    if (json(pins[name]) !== json(expected)) throw new Error('Host definition mismatch');
  }
  return host;
}

// Admission has no business invoker: it checks bytes and host pins without executing the program.
export function admitArtifact(artifactBytes, host) {
  const trusted = definitionForPins(host.pins);
  if (digest(host.dcmBytes) !== trusted.pins.modelDigest) throw new Error('Host definition mismatch');
  const task = host.pins.hook === TASK_HOOK, mode = task ? 'simulation' : 'real';
  const scope = task ? 'demo.task-completed:admission' : 'demo.task-advice:admission';
  const model = JSON.parse(host.dcmBytes);
  const implementations = Object.fromEntries(Object.entries(model.capabilities).map(([id, cap]) => [id, { version: cap.version, mode,
    ...(task ? { keyType: model.hostKey.type } : {}), invoke: async () => { throw new Error('Admission cannot dispatch'); } }]));
  const binding = task ? bindModel(host.dcmBytes, implementations) : bindModel(host.dcmBytes, { scope, modelRef: { domainId: 'demo.tasks', domainVersion: '1',
    format: 'keir-dcm/read-2', digest: host.pins.modelDigest, descriptorRecipe: 'keir-record-descriptors/1' },
    profile: host.pins.profile, environment: host.pins.environment, mode }, implementations);
  if (binding.diagnostic) throw new Error('Invalid host model');
  const result = task ? prepareProgram(artifactBytes, binding.boundModel) : prepareProgram(artifactBytes, binding.boundModel, { expectedArtifactDigest: digest(artifactBytes),
    expectedDcmDigest: host.pins.modelDigest, compiler: host.pins.compiler, entrypoint: host.pins.hook, consumer: host.pins.consumer,
    environment: host.pins.environment, mode });
  if (result.diagnostic) throw new Error('Invalid authored program');
  return JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
}

export function hostBindings(artifactBytes, owner) {
  const artifact = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  return artifact.steps.some(step => step.op === 'CALL' && ['tasks.get', 'tasks.create'].includes(step.capability)) ? { actorId: owner } : {};
}

export function loadCatalog() {
  const host = loadHost();
  return ['pending', 'attention'].map((id, index) => {
    const stem = index ? 'leo' : 'maya';
    const artifactBytes = load(`extensions/task-read/${stem}.json`);
    const source = load(`extensions/task-read/${stem}.yaml`);
    if (digest(artifactBytes) !== host.programs[stem].digest || digest(source) !== host.programs[stem].sourceDigest) throw new Error('Invalid program');
    const identity = { sourceDigest: digest(source), artifactDigest: digest(artifactBytes), ...host.pins };
    return Object.freeze({ id, label: index ? 'Needs attention' : 'Pending', openCode: index ? 'NEEDS_ATTENTION' : 'PENDING',
      identity: json(identity), pins: JSON.parse(json(identity)), artifactBytes, source: source.toString('utf8'), dcmBytes: host.dcmBytes });
  });
}
