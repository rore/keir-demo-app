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
export const BEFORE_CREATE = 'TaskBeforeCreate';
export const BEFORE_COMPLETE = 'TaskBeforeComplete';
export const TASK_CREATED = 'TaskCreated';
export const TASK_EVENT_HOOKS = Object.freeze([TASK_CREATED, TASK_HOOK]);
export const TASK_HOOKS = Object.freeze([...TASK_EVENT_HOOKS, 'TaskBeforeCreate']);
export const TASK_DEFINITION = 'daymark.task-workflow/1';
export const SHARED_COMPLETION_DEFINITION = 'daymark.shared-task/1';
export const SHARED_LOOKUP_DEFINITION = 'daymark.shared-task/2';
export const SHARED_PRIORITY_DEFINITION = 'daymark.shared-task/3';
export const SHARED_DUE_DEFINITION = 'daymark.shared-task/4';
export const SHARED_TAG_DEFINITION = 'daymark.shared-task/5';
export const SHARED_COMPLETED_UPDATE = 'daymark.shared-task/6';
export const SHARED_CREATED_DEFINITION = 'daymark.shared-task-created/1';
export const SHARED_CREATED_UPDATE = 'daymark.shared-task-created/2';
export const ownedProjectDefinitionId = (hook, version = '1') => `daymark.personal-owned-projects/${hook}/${version}`;
const SHARED_GUARD_DEFINITION = 'daymark.shared-before-create/1';
export const OWNED_GUARD_DEFINITION = 'daymark.shared-before-create/2';
const SHARED_COMPLETION_GATE = 'daymark.shared-before-complete/1';
const createdDigests = {
  PERSONAL: 'sha256:ae794465b9d34b9b2cc032f324da5d4bbd441e21c155f807b013f7942a410ab0',
  TEAM: 'sha256:6844df703bbce089f0679d569d81f02990080cffd169a214bf1677e98db65232',
};
const guardDigests = {
  PERSONAL: 'sha256:0d91f4ee7e5be7c9f5da20b6002e0ba4919e77330634764f97f25d9985261ea5',
  TEAM: 'sha256:54d56811aecc2a303a79eff58d4b5b741d9a1c20213d83d454b8099e084d6844',
};
export const ownedSourceUpdate = definitionId => TASK_EVENT_HOOKS.some(hook => definitionId === ownedProjectDefinitionId(hook, '2'));
export const exactLookupUpdate = definitionId => TASK_EVENT_HOOKS.some(hook => definitionId === ownedProjectDefinitionId(hook, '5'));
export const exactSourceUpdate = definitionId => exactLookupUpdate(definitionId) || TASK_EVENT_HOOKS.some(hook => definitionId === ownedProjectDefinitionId(hook, '3'));
export const exactOwnedCreate = definitionId => TASK_EVENT_HOOKS.some(hook => definitionId === ownedProjectDefinitionId(hook, '4'));
export const sharedSourceUpdate = definitionId => [SHARED_PRIORITY_DEFINITION, SHARED_DUE_DEFINITION, SHARED_TAG_DEFINITION, SHARED_COMPLETED_UPDATE,
  ...['2', '3', '5'].map(version => ownedProjectDefinitionId(TASK_HOOK, version))].includes(definitionId);
export const createdSourceUpdate = definitionId => [SHARED_CREATED_UPDATE,
  ...['2', '3', '5'].map(version => ownedProjectDefinitionId(TASK_CREATED, version))].includes(definitionId);
export const combinedSourceUpdate = definitionId => createdSourceUpdate(definitionId) || definitionId === SHARED_COMPLETED_UPDATE
  || ownedSourceUpdate(definitionId) || exactSourceUpdate(definitionId);

const archive = 'keir-runtime-node-0.5.0.tgz';
const packageIntegrity = 'sha512-tntrT/85XmNV0wmTyW0qG+4BREvsKaBGQt+CF16KssvhhD1sa9TM5I2dzm3TZjJXQ01sdYiPZgnHKFWt4PQ/hA==';
const core040Integrity = 'sha512-BmA7SC7gIYHFmqVlDPcG4Cv51OYRsGRNAImh3AraBZQ2BVhE7YpKIQbkTTSz/wTiZDpIrl1EV9aYxdZ2anDmTw==';
const core031Integrity = 'sha512-LZZjmNa3zeKE+BDqOzFPPXlQcIzeN/Ah8wohvaRjIc1rGh46hPFriL4E4z8sVNvHlYaAlVMd2yffjLR2qTs90g==';
const previousIntegrity = 'sha512-9MJu5RronOfAW78xZ/uj7Y28/1ZkKEz8pNUgqn7O+AsqL/Z3q9tGfbF00q8OUEiD78Ot/HiMhPPhpVuRtAR84w==';
const compiler = 'keir-compiler-java/0.5.0';
const earlierIntegrity = 'sha512-4Rxkk3sbguL7B8e438xEAZiQhmIYul2wvn3ZAAPaKtZsm/6Bpom9UhQGW9IA/zu4VHrtMaX5fM/kWNNeKx6nJg==';
const environment = Object.freeze({ celJava: '0.14.0', celNode: '0.6.1', protobufJava: '4.35.1', protobufNode: '2.6.2' });
const load = path => readFileSync(new URL('../' + path, import.meta.url));
const sharedDigests = { 1: {
  PERSONAL: 'sha256:90ae369e3a21d64faeade0399eaae0821f054995116b10623f0dac2757f5d0f1',
  TEAM: 'sha256:35408cadd8df110ad64a5684c400d23eaf70fb6b4ee540a7428c5e855b1f6805',
}, 2: {
  PERSONAL: 'sha256:f18d57dfd93058d0d68966743d48d646cd2a4999257bda6df0e1a16d122352aa',
  TEAM: 'sha256:c6926b4951a6605da3f7e4e505f46bcb3521ae7aff8a9977a4d1202d52923987',
}, 3: {
  PERSONAL: 'sha256:c4016f61aa4125f61ebcedf353524a58cce4816dd682093a62116b31adc31568',
  TEAM: 'sha256:af1f6f240654c5d4e3aeb3c0a69f29bb6a444ac407f8324246ae7ff0ab5a51c8',
}, 4: {
  PERSONAL: 'sha256:3e9fad410462a276f2f76afdcd7adcabb9bd858b61e16c9920e7868119267e7c',
  TEAM: 'sha256:627533e8463a133f518e81d939088d1f41c717cd2a1a511bc43095e3bb7d94b5',
}, 5: {
  PERSONAL: 'sha256:0fd725f40672c5477a2cc35a0a2d437a517a83e53532b5b1a50077a154cfa4ae',
  TEAM: 'sha256:f2682493350329205e8581cca3491f0b3790de4838f9ab7853e7d3d200d298c2',
}, 6: {
  PERSONAL: 'sha256:3a5b46da28018a1a8f2ac90061f39f4a261e55a5455c4c2cbd26789ce706a629',
  TEAM: 'sha256:e8a2e57d59c3f58fc4096987340b7b7d09729a9ac10470b900f29fd82724c3dd',
} };

// Shared definitions do not replace the pinned definitions in the compatibility catalog.
export function sharedCompletionDefinition(scope, version = '5') {
  if (!Object.hasOwn(sharedDigests, version) || !Object.hasOwn(sharedDigests[version], scope)) throw new Error('Unsupported shared task scope');
  const combined = version === '6', tags = combined || version === '5', due = tags || version === '4', priority = due || version === '3', lookup = version !== '1';
  const definitionId = combined ? SHARED_COMPLETED_UPDATE : tags ? SHARED_TAG_DEFINITION : due ? SHARED_DUE_DEFINITION : priority ? SHARED_PRIORITY_DEFINITION
    : lookup ? SHARED_LOOKUP_DEFINITION : SHARED_COMPLETION_DEFINITION;
  const base = JSON.parse(readCurrentDefinition().dcmBytes);
  const { Task, TaskId, ProjectId, UserId, EventId, Priority, TaskStatus, TaskEvent, Report, WorkflowStatus, TaskReference, Tags } = base.types;
  const create = base.capabilities['tasks.create'];
  const binding = 'agent';
  if (scope === 'TEAM') Object.assign(create.parameters, {
    parentTaskId: { type: 'TaskId', binding, optional: true },
    assigneeId: { type: 'UserId', binding, optional: true },
  });
  const entrypoint = { ...base.entrypoints[TASK_HOOK], effectGrant: 1 };
  const model = { format: 'keir-dcm/4', domain: { id: `daymark.shared-task.${scope.toLowerCase()}`, version },
    hostKey: { source: 'requestKey', type: 'daymark.SharedTaskEventKey/1' },
    types: { Task, TaskId, ProjectId, UserId, EventId, Priority, TaskStatus, TaskEvent, Report, WorkflowStatus, TaskReference, Tags,
      ...(lookup && { OpenMatch: base.types.OpenMatch }) },
    entrypoints: { [TASK_HOOK]: entrypoint },
    capabilities: { 'tasks.get': base.capabilities['tasks.get'], 'tasks.create': { ...create, version: '3' },
      ...(lookup && { 'tasks.openMatch': base.capabilities['tasks.openMatch'] }),
      ...(priority && { 'tasks.update': { ...base.capabilities['tasks.update'], version: combined ? '5' : tags ? '4' : due ? '3' : '2',
        parameters: { actorId: base.capabilities['tasks.update'].parameters.actorId, priority: { type: 'Priority', binding, ...(due && { optional: true }) },
          ...(due && { dueAt: { type: 'Timestamp', binding, optional: true }, clearDue: { type: 'Boolean', binding, optional: true } }),
          ...(tags && { addTag: base.capabilities['tasks.update'].parameters.addTag }) } } }) } };
  const dcmBytes = Buffer.from(json(model)), modelDigest = digest(dcmBytes);
  if (modelDigest !== sharedDigests[version][scope]) throw new Error('Shared task model digest mismatch: ' + modelDigest);
  const modelRef = { domainId: model.domain.id, domainVersion: model.domain.version, format: model.format,
    digest: modelDigest, descriptorRecipe: 'keir-record-descriptors/3' };
  return { definitionId, dcmBytes,
    pins: { modelDigest, modelRef, definitionId, compiler, environment, packageIntegrity,
      hook: TASK_HOOK, consumer: entrypoint.consumer, adapter: 'native-shared-completion/1' } };
}

export function readCurrentDefinition(hookId = TASK_HOOK) {
  return readDefinition(hookId, 'numeric');
}

export function sharedCreatedDefinition(scope, version = '1') {
  if (!['1', '2'].includes(version)) throw new Error('Unsupported shared created version');
  const base = sharedCompletionDefinition(scope);
  const model = JSON.parse(base.dcmBytes);
  model.domain = { id: `daymark.shared-task-created.${scope.toLowerCase()}`, version };
  const entry = JSON.parse(readCurrentDefinition(TASK_CREATED).dcmBytes).entrypoints[TASK_CREATED];
  model.entrypoints = { [TASK_CREATED]: { ...entry, effectGrant: 1 } };
  const definitionId = version === '1' ? SHARED_CREATED_DEFINITION : SHARED_CREATED_UPDATE;
  if (version === '1') delete model.capabilities['tasks.update'];
  else model.capabilities['tasks.update'].version = '5';
  const dcmBytes = Buffer.from(json(model)), modelDigest = digest(dcmBytes);
  if (version === '1' && modelDigest !== createdDigests[scope]) throw new Error('Shared created model digest mismatch: ' + modelDigest);
  return { definitionId, dcmBytes, pins: { ...base.pins, modelDigest,
    modelRef: { ...base.pins.modelRef, domainId: model.domain.id, domainVersion: model.domain.version, digest: modelDigest },
    definitionId, hook: TASK_CREATED, consumer: entry.consumer, adapter: 'native-shared-created/' + version } };
}

export function ownedProjectDefinition(hook, version = '1') {
  if (!TASK_EVENT_HOOKS.includes(hook) || !['1', '2', '3', '4', '5'].includes(version)) throw new Error('Unsupported owned-project definition');
  const update = ['2', '3', '5'].includes(version);
  const base = hook === TASK_CREATED ? sharedCreatedDefinition('PERSONAL', update ? '2' : '1')
    : sharedCompletionDefinition('PERSONAL', update ? '6' : '5');
  const model = JSON.parse(base.dcmBytes), definitionId = ownedProjectDefinitionId(hook, version);
  model.domain = { id: `daymark.personal-owned-projects.${hook.toLowerCase()}`, version };
  if (update) delete model.capabilities['tasks.create'];
  else {
    delete model.capabilities['tasks.update'];
    model.capabilities['tasks.create'].version = '4';
  }
  model.capabilities['tasks.openMatch'].version = '2';
  if (version === '3') delete model.capabilities['tasks.openMatch'];
  const dcmBytes = Buffer.from(json(model)), modelDigest = digest(dcmBytes);
  return { definitionId, dcmBytes, pins: { ...base.pins, definitionId, modelDigest,
    modelRef: { ...base.pins.modelRef, domainId: model.domain.id, domainVersion: model.domain.version, digest: modelDigest },
    adapter: 'native-personal-owned-projects/' + version } };
}

export function sharedBeforeCreateDefinition(scope, version = '1') {
  if (!Object.hasOwn(guardDigests, scope)) throw new Error('Unsupported shared task scope');
  if (version !== '1' && (version !== '2' || scope !== 'PERSONAL')) throw new Error('Unsupported shared guard version');
  const current = readCurrentDefinition(BEFORE_CREATE);
  const base = JSON.parse(current.dcmBytes), entry = base.entrypoints[BEFORE_CREATE];
  const domain = { id: `daymark.shared-before-create.${scope.toLowerCase()}`, version };
  const capabilities = { 'tasks.openMatch': base.capabilities['tasks.openMatch'] };
  if (version === '2') capabilities['tasks.get'] = base.capabilities['tasks.get'];
  const model = { ...base, domain, entrypoints: { [BEFORE_CREATE]: entry }, capabilities };
  const dcmBytes = Buffer.from(json(model)), modelDigest = digest(dcmBytes);
  if (version === '1' && modelDigest !== guardDigests[scope]) throw new Error('Shared guard model digest mismatch: ' + modelDigest);
  const definitionId = version === '2' ? OWNED_GUARD_DEFINITION : SHARED_GUARD_DEFINITION;
  return { definitionId, dcmBytes, pins: { ...current.pins, modelDigest,
    modelRef: { ...current.pins.modelRef, domainId: domain.id, domainVersion: domain.version, digest: modelDigest },
    definitionId, adapter: 'native-shared-before-create/' + version } };
}

export function sharedBeforeCompleteDefinition(scope) {
  if (scope !== 'TEAM') throw new Error('Completion gates require Team scope');
  const base = sharedBeforeCreateDefinition(scope), model = JSON.parse(base.dcmBytes);
  model.domain = { id: 'daymark.shared-before-complete.team', version: '1' };
  const entry = { ...model.entrypoints[BEFORE_CREATE], input: 'CompletionCandidate', event: { idType: 'EventId', sourceType: 'TaskId' },
    consumer: { ...model.entrypoints[BEFORE_CREATE].consumer, id: 'daymark.task.beforeComplete' } };
  model.entrypoints = { [BEFORE_COMPLETE]: entry };
  model.types.CompletionCandidate = { kind: 'record', fields: { ...model.types.TaskCreateProposal.fields,
    title: 'String', taskId: 'TaskId', creationEventId: 'EventId' } };
  model.types.LinkedTaskStatus = { kind: 'enum', values: ['MISSING', 'OPEN', 'COMPLETED'] };
  model.types.LinkedTaskSummary = { kind: 'record', fields: { status: 'LinkedTaskStatus' } };
  model.types = Object.fromEntries(['TaskId', 'EventId', 'ProjectId', 'UserId', 'Priority', 'Tags', 'Decision',
    'TaskCreateDecision', 'CompletionCandidate', 'LinkedTaskStatus', 'LinkedTaskSummary'].map(name => [name, model.types[name]]));
  model.capabilities = { 'tasks.linkedTask': { version: '1', effect: 'READ', errors: ['ACCESS_DENIED'],
    parameters: { actorId: { type: 'UserId', binding: 'host' }, parentTaskId: { type: 'TaskId', binding: 'agent' },
      originEventId: { type: 'EventId', binding: 'agent' } }, result: 'LinkedTaskSummary' } };
  const dcmBytes = Buffer.from(json(model)), modelDigest = digest(dcmBytes);
  return { definitionId: SHARED_COMPLETION_GATE, dcmBytes, pins: { ...base.pins, modelDigest,
    modelRef: { ...base.pins.modelRef, domainId: model.domain.id, domainVersion: model.domain.version, digest: modelDigest },
    definitionId: SHARED_COMPLETION_GATE, hook: BEFORE_COMPLETE, consumer: entry.consumer, adapter: 'native-shared-before-complete/1' } };
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
  if (exactOwnedCreate(pins?.definitionId) || exactSourceUpdate(pins?.definitionId) || ownedSourceUpdate(pins?.definitionId)
      || TASK_EVENT_HOOKS.some(hook => pins?.definitionId === ownedProjectDefinitionId(hook))) {
    const trusted = ownedProjectDefinition(pins.hook, exactLookupUpdate(pins.definitionId) ? '5' : exactOwnedCreate(pins.definitionId) ? '4'
      : exactSourceUpdate(pins.definitionId) ? '3' : ownedSourceUpdate(pins.definitionId) ? '2' : '1');
    if (definitionKey(trusted.pins) !== definitionKey(pins) || Object.hasOwn(pins, 'profile')) throw new Error('Host definition mismatch');
    return trusted;
  }
  if (pins?.definitionId === SHARED_COMPLETION_GATE) {
    const trusted = sharedBeforeCompleteDefinition('TEAM');
    if (definitionKey(trusted.pins) !== definitionKey(pins) || Object.hasOwn(pins, 'profile')) throw new Error('Host definition mismatch');
    return trusted;
  }
  if ([SHARED_CREATED_DEFINITION, SHARED_CREATED_UPDATE].includes(pins?.definitionId)) {
    const version = pins.definitionId === SHARED_CREATED_UPDATE ? '2' : '1';
    const trusted = Object.keys(createdDigests).map(scope => sharedCreatedDefinition(scope, version))
      .find(host => definitionKey(host.pins) === definitionKey(pins));
    if (!trusted || Object.hasOwn(pins, 'profile')) throw new Error('Host definition mismatch');
    return trusted;
  }
  if ([SHARED_GUARD_DEFINITION, OWNED_GUARD_DEFINITION].includes(pins?.definitionId)) {
    const trusted = pins.definitionId === OWNED_GUARD_DEFINITION ? sharedBeforeCreateDefinition('PERSONAL', '2')
      : sharedBeforeCreateDefinition(Object.keys(guardDigests).find(scope => guardDigests[scope] === pins.modelDigest));
    if (definitionKey(trusted.pins) !== definitionKey(pins) || Object.hasOwn(pins, 'profile')) throw new Error('Host definition mismatch');
    return trusted;
  }
  if ([SHARED_COMPLETION_DEFINITION, SHARED_LOOKUP_DEFINITION].includes(pins?.definitionId) || sharedSourceUpdate(pins?.definitionId)) {
    const version = pins.definitionId === SHARED_COMPLETED_UPDATE ? '6' : pins.definitionId === SHARED_TAG_DEFINITION ? '5'
      : pins.definitionId === SHARED_DUE_DEFINITION ? '4' : pins.definitionId === SHARED_PRIORITY_DEFINITION ? '3'
      : pins.definitionId === SHARED_LOOKUP_DEFINITION ? '2' : '1';
    const scope = Object.keys(sharedDigests[version]).find(name => sharedDigests[version][name] === pins.modelDigest);
    const trusted = sharedCompletionDefinition(scope, version);
    if (definitionKey(trusted.pins) !== definitionKey(pins) || Object.hasOwn(pins, 'profile')) throw new Error('Host definition mismatch');
    return trusted;
  }
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
