import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { types as nodeTypes } from 'node:util';
import { admitArtifact, definitionForPins, digest, hostBindings, json, TASK_HOOKS } from './extension-catalog.mjs';
import { decodeKeirScenario } from './keir-scenario.mjs';
import { normalizeTaskTag, normalizeTaskTags, parseWorkflowTagsText, validOpenMatchInput, normalizeWorkflowTitle } from './task-workflow-values.mjs';

const earlierVersions = Object.freeze({
  suite: 'task-effects-authored/2', fixtureVersion: 'daymark-task-effect-fixtures/2', simulator: 'daymark-task-effect-simulation/2',
});
export const TASK_EFFECT_VERSIONS = Object.freeze({
  suite: 'task-effects-authored/3', fixtureVersion: 'daymark-task-effect-fixtures/3', simulator: 'daymark-task-effect-simulation/3',
});
export function taskEffectVersions(host) {
  if (host?.pins?.modelRef?.format === 'keir-dcm/2') return earlierVersions;
  if (host?.pins?.modelRef?.format === 'keir-dcm/3') return TASK_EFFECT_VERSIONS;
  throw new Error('Unsupported task simulation model');
}
const decisionHost = host => host.pins.consumer.kind === 'DECISION';

const own = (value, key) => Object.hasOwn(value, key);
const bounded = (value, max = 256) => typeof value === 'string' && value.isWellFormed() && value.length > 0 && Buffer.byteLength(value) <= max;
function requireThat(condition) { if (!condition) throw new Error('Invalid task effect data'); }
function closed(value, required, optional = []) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) && !nodeTypes.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const names = Reflect.ownKeys(value);
  requireThat(names.length <= required.length + optional.length && required.every(name => own(value, name))
    && names.every(name => typeof name === 'string' && (required.includes(name) || optional.includes(name))
      && Object.getOwnPropertyDescriptor(value, name)?.enumerable && own(Object.getOwnPropertyDescriptor(value, name), 'value')));
}
function array(value, max) {
  requireThat(Array.isArray(value) && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) requireThat(own(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, 'value'));
}
function snapshot(value, max = 65_536, depth = 0) {
  requireThat(depth <= 16);
  if (typeof value === 'string') requireThat(value.isWellFormed());
  else if (typeof value === 'number') requireThat(Number.isSafeInteger(value));
  else if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) array(value, 128);
    else closed(value, Object.keys(value));
    for (const item of Object.values(value)) snapshot(item, max, depth + 1);
  } else requireThat(value === null || typeof value === 'boolean');
  const bytes = json(value);
  requireThat(Buffer.byteLength(bytes) <= max);
  return JSON.parse(bytes);
}
const same = (left, right) => json(left) === json(right);
const token = value => bounded(value, 64) && /^[A-Z][A-Z0-9_]*$/.test(value);
const step = value => bounded(value, 64) && /^[A-Za-z][A-Za-z0-9]*$/.test(value);
const states = ['CONFIRMED', 'NONE', 'UNKNOWN'];
const classifications = ['COMPLETED', 'BUSINESS_REJECTION', 'FAILED', 'LIMIT_EXCEEDED', 'UNCERTAIN'];
const fixtureActor = 'user1';
const traceFields = {
  INVOCATION_START: [], STEP_START: ['step'], GUARD_EVALUATED: ['step', 'taken'], STEP_SKIPPED: ['step'], VALUE_BOUND: ['step'],
  EFFECT_INTENT: ['step', 'capability'], CALL_DISPATCHED: ['step', 'capability'], EFFECT_RECORDED: ['step', 'capability', 'state'],
  CALL_SUCCEEDED: ['step', 'capability'], RETURNED: [], TERMINATED: [],
};
const fixtures = ['normal', 'invocation-denied', 'write-denied', 'invalid-key', 'wrong-origin',
  'read-throws', 'lost-response', 'response-expired', 'response-bad-clock'];
function errorShape(error, cause = true) {
  closed(error, ['code', 'path'], cause ? ['cause'] : []);
  requireThat(token(error.code) && typeof error.path === 'string' && error.path.isWellFormed() && Buffer.byteLength(error.path) <= 1024);
  if (own(error, 'cause')) {
    errorShape(error.cause, false);
    const handler = error.cause.path + '/onError/' + error.cause.code;
    requireThat(/^\/steps\/[0-7]$/.test(error.cause.path) && (error.path === handler || error.path.startsWith(handler + '/')));
  }
}
function checkedHost(host) {
  const trusted = definitionForPins(host.pins);
  requireThat(TASK_HOOKS.includes(trusted.pins.hook) && host.definitionId === trusted.definitionId
    && host.dcmBytes instanceof Uint8Array && Buffer.from(host.dcmBytes).equals(trusted.dcmBytes));
  return trusted;
}
function validateOutcome(outcome, dcm, hook) {
  closed(outcome, ['classification', 'effects', 'trace'], ['result', 'error']);
  requireThat(classifications.includes(outcome.classification));
  array(outcome.effects, 1); array(outcome.trace, 64);
  requireThat(outcome.trace.length >= 2);
  if (own(outcome, 'result')) validateValue(dcm, dcm.entrypoints[hook].output, outcome.result);
  if (own(outcome, 'error')) errorShape(outcome.error, ['FAILED', 'LIMIT_EXCEEDED'].includes(outcome.classification));
  const ledger = [], intents = new Map(), dispatches = new Set();
  for (const [index, event] of outcome.trace.entries()) {
    requireThat(typeof event?.event === 'string' && own(traceFields, event.event));
    closed(event, ['sequence', 'event', ...traceFields[event.event]], event.event === 'TERMINATED' ? ['code'] : []);
    requireThat(event.sequence === index && (event.event !== 'INVOCATION_START' || index === 0)
      && (event.event !== 'TERMINATED' || index === outcome.trace.length - 1));
    if (own(event, 'step')) requireThat(step(event.step));
    if (own(event, 'capability')) requireThat(own(dcm.capabilities, event.capability));
    if (own(event, 'taken')) requireThat(typeof event.taken === 'boolean');
    if (own(event, 'code')) requireThat(token(event.code));
    if (event.event === 'EFFECT_INTENT') {
      requireThat(dcm.capabilities[event.capability].effect === 'WRITE' && !intents.size);
      intents.set(event.step, event.capability);
    }
    if (event.event === 'CALL_DISPATCHED') {
      requireThat(!dispatches.has(event.step + '/' + event.capability));
      if (dcm.capabilities[event.capability].effect === 'WRITE') requireThat(intents.get(event.step) === event.capability);
      dispatches.add(event.step + '/' + event.capability);
    }
    if (event.event === 'EFFECT_RECORDED') {
      requireThat(states.includes(event.state) && intents.get(event.step) === event.capability
        && dispatches.has(event.step + '/' + event.capability) && !ledger.length);
      ledger.push({ step: event.step, capability: event.capability, state: event.state });
    }
  }
  requireThat(outcome.trace[0].event === 'INVOCATION_START' && outcome.trace.at(-1).event === 'TERMINATED'
    && intents.size === ledger.length && same(ledger, outcome.effects));
  requireThat(own(outcome, 'error') ? outcome.trace.at(-1).code === outcome.error.code : !own(outcome.trace.at(-1), 'code'));
  const hasResult = own(outcome, 'result'), hasError = own(outcome, 'error'), state = ledger[0]?.state;
  if (outcome.classification === 'COMPLETED') requireThat(hasResult && !hasError && (!state || state === 'CONFIRMED'));
  else if (outcome.classification === 'BUSINESS_REJECTION') {
    requireThat(hasError && state !== 'UNKNOWN');
    if (state === 'CONFIRMED') {
      const confirmation = outcome.trace.find(event => event.event === 'EFFECT_RECORDED');
      const lastCall = outcome.trace.findLast(event => event.event === 'CALL_DISPATCHED');
      requireThat(lastCall.sequence > confirmation.sequence && lastCall.step !== ledger[0].step);
    }
  } else if (outcome.classification === 'UNCERTAIN') requireThat(hasError && !hasResult && state === 'UNKNOWN');
  else requireThat(hasError && !hasResult && state !== 'UNKNOWN');
  return outcome;
}

function reported(value) {
  const { classification, effects, result, error } = value;
  return { status: 'REPORTED', classification, ...(own(value, 'result') ? { result } : {}),
    ...(own(value, 'error') ? { error } : {}), effects };
}

// A program label never establishes a native effect; the runtime ledger and trace do.
export function consumeTaskEffect(outcome, host) {
  try {
    const trusted = checkedHost(host), value = snapshot(outcome);
    validateOutcome(value, JSON.parse(trusted.dcmBytes), trusted.pins.hook);
    return reported(value);
  } catch { return { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' }; }
}

function decisionConsumer(dcm, hook) {
  requireThat(hook === 'TaskBeforeCreate' && dcm.entrypoints[hook].consumer.kind === 'DECISION');
  return outcome => {
    try {
      const value = snapshot(outcome);
      validateOutcome(value, dcm, hook);
      requireThat(value.classification === 'COMPLETED' && value.effects.length === 0);
      closed(value.result, ['decision', 'message']);
      requireThat(['ALLOW', 'DENY'].includes(value.result.decision) && typeof value.result.message === 'string');
      let index = 0, calls = 0;
      const steps = new Set(), next = () => value.trace[index]?.event;
      const take = name => {
        const event = value.trace[index++];
        requireThat(event?.event === name);
        return event;
      };
      take('INVOCATION_START');
      while (next() === 'STEP_START') {
        const { step } = take('STEP_START');
        requireThat(!steps.has(step) && steps.size < 8);
        steps.add(step);
        const sameStep = name => {
          const event = take(name);
          requireThat(event.step === step);
          return event;
        };
        if (next() === 'VALUE_BOUND') { sameStep('VALUE_BOUND'); continue; }
        if (next() === 'GUARD_EVALUATED' && !sameStep('GUARD_EVALUATED').taken) {
          sameStep('STEP_SKIPPED'); continue;
        }
        const { capability } = sameStep('CALL_DISPATCHED');
        requireThat(dcm.capabilities[capability].effect === 'READ' && ++calls <= 4);
        requireThat(sameStep('CALL_SUCCEEDED').capability === capability);
      }
      requireThat(steps.size > 0);
      take('RETURNED'); take('TERMINATED');
      requireThat(index === value.trace.length);
      return { status: value.result.decision === 'ALLOW' ? 'ALLOWED' : 'DENIED', result: value.result };
    } catch { return { status: 'BLOCKED' }; }
  };
}
export function createTaskDecisionConsumer(host) {
  const trusted = checkedHost(host);
  return decisionConsumer(JSON.parse(trusted.dcmBytes), trusted.pins.hook);
}
function validateFields(dcm, declarations, value) {
  const optional = name => declarations[name]?.optional === true;
  const fields = Object.keys(declarations);
  closed(value, fields.filter(name => !optional(name)), fields.filter(optional));
  for (const [name, item] of Object.entries(value)) {
    const type = declarations[name];
    validateValue(dcm, typeof type === 'string' ? type : type.type, item);
  }
}
function validateValue(dcm, name, value) {
  const type = dcm.types[name];
  if (type?.kind === 'record') validateFields(dcm, type.fields, value);
  else if (type?.kind === 'list') {
    array(value, type.maxItems);
    for (const item of value) validateValue(dcm, type.element, item);
  } else if (type?.kind === 'enum') requireThat(type.values.includes(value));
  else if (name === 'Boolean') requireThat(typeof value === 'boolean');
  else if (name === 'Timestamp') {
    requireThat(typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  } else if (name === 'String') requireThat(value === '' || bounded(value));
  else requireThat(type?.kind === 'nominal' && bounded(value));
}
function validateCall(call, dcm, input, stub = false) {
  requireThat(own(dcm.capabilities, call.capability));
  const cap = dcm.capabilities[call.capability];
  requireThat(call.version === cap.version);
  const parameters = binding => Object.fromEntries(Object.entries(cap.parameters).filter(([, param]) => param.binding === binding));
  validateFields(dcm, parameters('agent'), call.args);
  validateFields(dcm, parameters('host'), call.protectedArgs);
  requireThat(call.protectedArgs.actorId === fixtureActor);
  if (!stub) return;
  const response = call.response, write = cap.effect === 'WRITE';
  if (response?.kind === 'SUCCESS') {
    closed(response, ['kind', 'value', ...(write ? ['effect'] : [])]);
    validateValue(dcm, cap.result, response.value);
    if (call.capability === 'tasks.get') {
      const { id, title, tags } = response.value;
      requireThat(id === call.args.taskId && normalizeWorkflowTitle(title) === title
        && same(tags, normalizeTaskTags(tags)));
    }
    if (call.capability === 'tasks.create') requireThat(response.value.id !== input.taskId);
    if (call.capability === 'tasks.update') requireThat(response.value.id === input.taskId);
    if (write) requireThat(response.effect === 'CONFIRMED');
  } else if (response?.kind === 'BUSINESS_REJECTION') {
    closed(response, ['kind', 'code', ...(write ? ['effect'] : [])]);
    requireThat(dcm.capabilities[call.capability].errors.includes(response.code) && (!write || response.effect === 'NONE'));
  } else if (response?.kind === 'TRANSIENT_FAILURE') {
    closed(response, ['kind', ...(write ? ['effect'] : [])]); requireThat(!write || response.effect === 'NONE');
  } else {
    closed(response, ['kind', 'effect']); requireThat(write && response.kind === 'UNKNOWN_COMMIT' && response.effect === 'UNKNOWN');
  }
}
function scenarioError(caseIndex, code, cause) {
  return Object.assign(new Error('Invalid task effect scenario', { cause }), { caseIndex, code });
}
export function decodeTaskEffectScenarios(scenarios) {
  array(scenarios, 16); requireThat(scenarios.length > 0);
  const ids = new Set();
  return scenarios.map((raw, index) => {
    let row;
    try {
      requireThat(raw instanceof Uint8Array || typeof raw === 'string' && raw.length <= 65_536 && raw.isWellFormed());
      row = decodeKeirScenario(typeof raw === 'string' ? Buffer.from(raw) : raw);
    } catch (cause) { throw scenarioError(index, 'INVALID_SCENARIO', cause); }
    if (ids.has(row.id)) throw scenarioError(index, 'DUPLICATE_SCENARIO_ID');
    ids.add(row.id);
    return row;
  });
}
function validateRows(rows, artifact, host) {
  const dcm = JSON.parse(host.dcmBytes);
  const consume = decisionHost(host) ? decisionConsumer(dcm, host.pins.hook) : reported;
  rows.forEach(({ given, stubs, expect }, index) => {
    try {
      requireThat(rows[index].format === (dcm.format === 'keir-dcm/3' ? 'keir-scenario/3' : 'keir-scenario/2') && fixtures.includes(given.fixture));
      validateValue(dcm, dcm.entrypoints[host.pins.hook].input, given.input);
      stubs.forEach(call => validateCall(call, dcm, given.input, true));
      expect.calls.forEach(call => validateCall(call, dcm, given.input));
      validateOutcome(expect.outcome, dcm, host.pins.hook);
      requireThat(same(consume(expect.outcome), expect.consumption));
      requireThat(same(stubs.map(({ response, ...call }) => call), expect.calls));
      const targets = calls => calls.map(({ step, capability }) => ({ step, capability }));
      const dispatched = expect.outcome.trace.filter(event => event.event === 'CALL_DISPATCHED');
      requireThat(same(targets(dispatched), targets(expect.calls)));
      requireThat(expect.outcome.trace.every(event => event.event !== 'GUARD_EVALUATED' || event.taken
        || !dispatched.some(call => call.step === event.step)));
      requireThat(expect.calls.every(call => artifact.steps.some(step => step.id === call.step && step.op === 'CALL' && step.capability === call.capability)));
      taskEffectExpected(rows[index]);
    } catch (cause) { throw scenarioError(index, 'INVALID_SCENARIO', cause); }
  });
}
function preflight(artifactBytes, host, scenarios) {
  const rows = decodeTaskEffectScenarios(scenarios);
  requireThat(artifactBytes instanceof Uint8Array && artifactBytes.byteLength <= 1_048_576);
  const trusted = checkedHost(host);
  validateRows(rows, admitArtifact(artifactBytes, trusted), trusted);
  return { rows, trusted };
}
export function preflightTaskEffectScenarios(artifactBytes, host, scenarios) {
  return preflight(artifactBytes, host, scenarios).rows;
}
const isWrite = capability => capability === 'tasks.create' || capability === 'tasks.update';
function taskChanges(capability, args, task) {
  if (capability === 'tasks.create') {
    const { title, tagsText, ...other } = args;
    return { ...other, title: normalizeWorkflowTitle(title), tags: parseWorkflowTagsText(tagsText) };
  }
  requireThat(Object.keys(args).length > 0);
  const { addTag, ...other } = args;
  if (addTag === undefined) return other;
  const tag = normalizeTaskTag(addTag);
  if (task) normalizeTaskTags([...task.tags, tag]);
  return { ...other, addTag: tag };
}
const unavailable = effect => ({ effect, createdTasks: null, updatedTasks: null });
function observations(calls, responses, outcome) {
  const receipt = outcome.effects[0];
  if (receipt?.state === 'UNKNOWN') return unavailable('UNKNOWN');
  if (receipt?.state !== 'CONFIRMED') return { effect: 'NONE', createdTasks: [], updatedTasks: [] };
  const ordinal = calls.findIndex(call => call.step === receipt.step && call.capability === receipt.capability);
  const call = calls[ordinal], response = responses[ordinal];
  requireThat(call && response?.kind === 'SUCCESS' && response.effect === 'CONFIRMED');
  const task = { id: response.value.id, ...taskChanges(call.capability, call.args) };
  return { effect: 'CONFIRMED', createdTasks: call.capability === 'tasks.create' ? [task] : [],
    updatedTasks: call.capability === 'tasks.update' ? [task] : [] };
}
export function taskEffectExpected(row) {
  const { expect } = row;
  const { createdTasks, updatedTasks } = observations(expect.calls, row.stubs.map(call => call.response), expect.outcome);
  return { ...expect, createdTasks, updatedTasks };
}
function scenarioDetails(input, calls, responses, outcome) {
  if (Object.hasOwn(input, 'hasNotes')) return { proposal: snapshot(input) };
  const successes = calls.map((call, ordinal) => ({ call, response: responses[ordinal] }))
    .filter(({ call, response }) => response?.kind === 'SUCCESS'
      && outcome.trace.some(event => event.event === 'CALL_SUCCEEDED' && event.step === call.step && event.capability === call.capability));
  const read = successes.find(({ call }) => call.capability === 'tasks.get' && call.args.taskId === input.taskId);
  const openMatches = successes.filter(({ call }) => call.capability === 'tasks.openMatch')
    .map(({ call, response }) => ({ ...call.args, matches: response.value.matches }));
  return { task: read?.response.value ?? { id: input.taskId, title: 'Example task' }, occurredAt: input.occurredAt, openMatches };
}
async function runCase(artifactBytes, host, row, signal) {
  const captures = [], responses = [], violations = [], fixture = row.given.fixture;
  let task;
  let used = 0, now = 0;
  const decision = decisionHost(host);
  const key = decision && fixture === 'invalid-key' ? null : Object.freeze(Object.create(null));
  const source = decision ? row.given.input.projectId : row.given.input.taskId;
  const event = Object.freeze({ id: 'example-event', source: fixture === 'wrong-origin' ? 'other-task' : source });
  const deadline = { clock: { nowMs: () => now }, expiresAtMs: 1000 }, model = JSON.parse(host.dcmBytes);
  const add = (stage, code, ordinal = 0) => { if (violations.length < 8) violations.push({ stage, code, ordinal }); };
  const invokers = Object.fromEntries(Object.entries(model.capabilities).map(([capability, cap]) => [capability, {
    version: cap.version, mode: 'simulation', keyType: model.hostKey.type,
    invoke(args, protectedArgs, remainingMs, context) {
      const capture = snapshot({ capability, version: cap.version, args, protectedArgs }); captures.push(capture);
      const stub = row.stubs[used];
      try {
        requireThat(Number.isSafeInteger(remainingMs) && remainingMs > 0 && context.requestKey === key && same(context.event, event)
          && context.deadline.clock.nowMs() === now && context.deadline.expiresAtMs === deadline.expiresAtMs && protectedArgs.actorId === fixtureActor);
        requireThat(stub && same(capture, { capability: stub.capability, version: stub.version, args: stub.args, protectedArgs: stub.protectedArgs }));
        if (capability === 'tasks.get') requireThat(stub.response.kind !== 'SUCCESS' || stub.response.value.id === args.taskId);
        used++;
      } catch { add('STUB', 'STUB_MISMATCH', captures.length); throw new Error('Task effect fixture mismatch'); }
      const write = isWrite(capability);
      if (signal?.aborted || fixture === 'invocation-denied' || fixture === 'invalid-key' || event.source !== source
          || fixture === 'write-denied' && write) {
        return { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', ...(write ? { effect: 'NONE' } : {}) };
      }
      if (capability === 'tasks.openMatch' && !validOpenMatchInput(args.projectId, args.title)) return { kind: 'TRANSIENT_FAILURE' };
      if (write && !(stub.response.kind === 'BUSINESS_REJECTION' && stub.response.code !== 'TASK_INVALID')) {
        try { taskChanges(capability, args, task); }
        catch { return { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' }; }
      }
      if (fixture === 'read-throws' && !write || fixture === 'lost-response' && write)
        throw new Error('Simulated unavailable response');
      if (write && fixture === 'response-expired') now = 1000;
      if (write && fixture === 'response-bad-clock') now = -1;
      const response = snapshot(stub.response);
      responses[captures.length - 1] = response;
      if (capability === 'tasks.get' && args.taskId === row.given.input.taskId && response.kind === 'SUCCESS') task = response.value;
      return response;
    },
  }]));
  const binding = bindModel(host.dcmBytes, invokers);
  requireThat(!binding.diagnostic);
  const selection = prepareProgram(artifactBytes, binding.boundModel);
  requireThat(!selection.diagnostic);
  const native = await invokeProgram(selection.prepared, row.given.input, { bindings: hostBindings(artifactBytes, fixtureActor), requestKey: key, event, deadline });
  const dispatches = native.trace.filter(item => item.event === 'CALL_DISPATCHED');
  if (dispatches.length !== captures.length || used !== row.stubs.length) add('STUB', 'STUB_COUNT_MISMATCH');
  const calls = captures.map((capture, ordinal) => {
    const dispatch = dispatches[ordinal];
    if (!dispatch || dispatch.capability !== capture.capability || dispatch.step !== row.stubs[ordinal]?.step) add('STUB', 'DISPATCH_MISMATCH', ordinal + 1);
    return { step: dispatch?.step ?? '', ...capture };
  });
  const consumption = decision ? createTaskDecisionConsumer(host)(native) : consumeTaskEffect(native, host);
  if (!same(native, row.expect.outcome)) add('OUTCOME', 'MISMATCH');
  if (!same(calls, row.expect.calls)) add('CALLS', 'MISMATCH');
  if (!same(consumption, row.expect.consumption)) add('CONSUMPTION', 'MISMATCH');
  const observed = (!decision && consumption.status !== 'REPORTED') || violations.some(item => item.stage === 'STUB')
    ? unavailable('NOT_OBSERVED') : observations(calls, responses, native);
  return { id: row.id, label: row.id, expected: taskEffectExpected(row), report: {
    status: violations.length ? 'FAIL' : 'PASS', native, consumption, calls, mismatches: violations,
    scenario: scenarioDetails(row.given.input, calls, responses, native), observed,
  } };
}

export async function runTaskEffectSimulation({ artifactBytes, host, scenarios, signal } = {}) {
  let trusted, identity = {}, rows;
  let versions = TASK_EFFECT_VERSIONS;
  const reports = [];
  try {
    requireThat(signal === undefined || signal instanceof AbortSignal);
    requireThat(artifactBytes instanceof Uint8Array && artifactBytes.byteLength <= 1_048_576);
    artifactBytes = Buffer.from(artifactBytes);
    ({ rows, trusted } = preflight(artifactBytes, host, scenarios));
    versions = taskEffectVersions(trusted);
    identity = { ...trusted.pins, artifactDigest: digest(artifactBytes), simulator: versions.simulator, fixture: versions.fixtureVersion };
  } catch { return { format: versions.simulator, status: 'FAIL', identity, reports, mismatches: [{ stage: 'SCENARIO', code: 'INVALID' }] }; }
  for (const row of rows) {
    if (signal?.aborted) return { format: versions.simulator, status: 'FAIL', identity, reports, mismatches: [{ stage: 'EXECUTION', code: 'CANCELLED' }] };
    try { reports.push(await runCase(artifactBytes, trusted, row, signal)); }
    catch { reports.push({ id: row.id, label: row.id, expected: row.expect, report: { status: 'FAIL', mismatches: [{ stage: 'SETUP', code: 'UNAVAILABLE' }] } }); }
  }
  return { format: versions.simulator, status: reports.every(item => item.report.status === 'PASS') ? 'PASS' : 'FAIL', identity, reports };
}

// Lifecycle and native commit guards must validate the same saved proof, including its actual reports.
export function taskEffectProofMatches(revision, authored, proof, host) {
  try {
    const pins = JSON.parse(revision.identity);
    const versions = taskEffectVersions(host);
    if (!TASK_HOOKS.includes(pins.hook) || own(pins, 'profile') || own(pins, 'qualification')
        || Object.entries(host.pins).some(([name, value]) => !same(pins[name], value))
        || pins.fixture !== versions.fixtureVersion || revision.identity !== json(pins)
        || pins.rawSourceDigest !== digest(authored.source) || pins.artifactDigest !== digest(authored.artifact)
        || pins.suiteDigest !== digest(authored.suite) || proof.owner_id !== revision.owner_id
        || proof.revision_id !== revision.id || proof.identity !== revision.identity || proof.passed !== 1
        || Buffer.byteLength(proof.payload) > 131072) return false;
    // Native guards re-read proof rows against the deployment captured by their service.
    const texts = JSON.parse(authored.suite), scenarios = decodeTaskEffectScenarios(texts);
    const artifact = JSON.parse(Buffer.from(authored.artifact).toString('utf8'));
    if (artifact.format !== (pins.modelRef.format === 'keir-dcm/3' ? 'keir-artifact/3' : 'keir-artifact/2') || own(artifact, 'profile') || artifact.compiler !== pins.compiler
        || artifact.entrypoint !== pins.hook || !same(artifact.modelRef, pins.modelRef) || !same(artifact.environment, pins.environment)
        || !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest) || pins.compiledSourceDigest !== artifact.sourceDigest) return false;
    validateRows(scenarios, artifact, host);
    const suiteIdentity = digest(json({ ...versions, simulator: revision.identity,
      cases: scenarios.map((scenario, index) => ({ id: scenario.id, digest: digest(texts[index]) })) }));
    const payload = JSON.parse(proof.payload);
    return proof.suite_identity === suiteIdentity
      && json(payload.identity) === json({ dependencies: pins, ...versions, suiteDigest: suiteIdentity })
      && payload.reports.length === scenarios.length && payload.reports.every((item, index) => {
        const scenario = scenarios[index], expected = scenario.expect.outcome, report = item.report;
        const responses = scenario.stubs.map(call => call.response);
        return item.id === scenario.id && item.label === scenario.id
          && same(item.expected, taskEffectExpected(scenario))
          && report.status === 'PASS' && Array.isArray(report.mismatches) && report.mismatches.length === 0
          && same(report.native, expected) && same(report.calls, scenario.expect.calls)
          && same(report.consumption, scenario.expect.consumption)
          && same(report.observed, observations(scenario.expect.calls, responses, expected))
          && same(report.scenario, scenarioDetails(scenario.given.input, scenario.expect.calls, responses, expected));
      });
  } catch { return false; }
}

// Format guidance only. Customer project and title must be resolved and authored separately.
export function taskEffectSyntax(host) {
  const trusted = checkedHost(host), model = JSON.parse(trusted.dcmBytes);
  if (decisionHost(trusted)) return JSON.stringify({ language: 'keir/2', domain: { ...model.domain, fingerprint: trusted.pins.modelDigest },
    entrypoint: trusted.pins.hook, name: 'format-only-task-check',
    steps: [{ id: 'needsDetails', let: { cel: 'input.priority == "high" && !input.hasNotes' } }],
    return: { record: { decision: { cel: 'needsDetails ? "DENY" : "ALLOW"' },
      message: { cel: 'needsDetails ? "Add notes for this task." : ""' } } } }, null, 2);
  const completion = trusted.pins.hook === 'TaskCompleted', status = completion ? 'COMPLETED' : 'OPEN';
  return JSON.stringify({ language: 'keir/2', domain: { ...model.domain, fingerprint: trusted.pins.modelDigest }, entrypoint: trusted.pins.hook,
    name: 'format-only-task-example', steps: [
      { id: 'eligibleProject', let: { literal: 'project1', type: 'ProjectId' } },
      { id: 'source', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
      { id: 'eligible', let: { cel: `source.status == "${status}" && source.projectId == eligibleProject` } },
      { id: 'created', call: 'tasks.create', when: 'eligible', args: { projectId: { cel: 'eligibleProject' }, title: { literal: 'Example follow-up task' } } },
    ], return: { record: { status: { cel: 'eligible ? "CREATED" : "NO_OP"' } } } }, null, 2);
}
export function taskEffectScenarioExamples(host) {
  const trusted = checkedHost(host), model = JSON.parse(trusted.dcmBytes), capability = model.capabilities['tasks.get'];
  if (decisionHost(trusted)) return [
    ['notes-present', 'high', true, false], ['notes-missing', 'high', false, true],
    ['other-priority', 'normal', false, false], ['check-unavailable', 'high', true, false],
  ].map(([id, priority, hasNotes, denied]) => {
    const unavailable = id === 'check-unavailable';
    const result = { decision: denied ? 'DENY' : 'ALLOW', message: denied ? 'Add notes for this task.' : '' };
    const trace = unavailable ? [{ event: 'INVOCATION_START' }, { event: 'TERMINATED', code: 'HOST_CONTEXT_INVALID' }]
      : [{ event: 'INVOCATION_START' }, { event: 'STEP_START', step: 'needsDetails' }, { event: 'VALUE_BOUND', step: 'needsDetails' },
        { event: 'RETURNED' }, { event: 'TERMINATED' }];
    const outcome = { classification: unavailable ? 'FAILED' : 'COMPLETED',
      ...(unavailable ? { error: { code: 'HOST_CONTEXT_INVALID', path: '' } } : { result }), effects: [],
      trace: trace.map((event, sequence) => ({ ...event, sequence })) };
    return JSON.stringify({ format: 'keir-scenario/3', id,
      given: { fixture: unavailable ? 'invalid-key' : 'normal', input: { projectId: 'project1', priority, tags: [], hasNotes, hasDueDate: false } },
      stubs: [], expect: { outcome, calls: [], consumption: unavailable ? { status: 'BLOCKED' }
        : { status: denied ? 'DENIED' : 'ALLOWED', result } } });
  });
  const status = trusted.pins.hook === 'TaskCompleted' ? 'COMPLETED' : 'OPEN';
  const given = { input: { taskId: 'task1', occurredAt: '2026-03-07T12:34:56.789Z' }, fixture: 'normal' };
  const read = { step: 'source', capability: 'tasks.get', version: capability.version, args: { taskId: 'task1' }, protectedArgs: { actorId: fixtureActor } };
  const rows = [
    ['matching-project', 'project1', status, true],
    ['other-project', 'project2', status, false],
    ['other-status', 'project1', status === 'COMPLETED' ? 'OPEN' : 'COMPLETED', false],
  ].map(([id, projectId, status, match]) => {
    const write = { step: 'created', capability: 'tasks.create', version: model.capabilities['tasks.create'].version,
      args: { projectId: 'project1', title: 'Example follow-up task' }, protectedArgs: { actorId: fixtureActor } };
    const events = [
      { event: 'INVOCATION_START' }, { event: 'STEP_START', step: 'eligibleProject' }, { event: 'VALUE_BOUND', step: 'eligibleProject' },
      { event: 'STEP_START', step: 'source' }, { event: 'CALL_DISPATCHED', step: 'source', capability: 'tasks.get' },
      { event: 'CALL_SUCCEEDED', step: 'source', capability: 'tasks.get' }, { event: 'STEP_START', step: 'eligible' }, { event: 'VALUE_BOUND', step: 'eligible' },
      { event: 'STEP_START', step: 'created' }, { event: 'GUARD_EVALUATED', step: 'created', taken: match },
      ...(match ? [{ event: 'EFFECT_INTENT', step: 'created', capability: 'tasks.create' }, { event: 'CALL_DISPATCHED', step: 'created', capability: 'tasks.create' },
        { event: 'EFFECT_RECORDED', step: 'created', capability: 'tasks.create', state: 'CONFIRMED' }, { event: 'CALL_SUCCEEDED', step: 'created', capability: 'tasks.create' }]
        : [{ event: 'STEP_SKIPPED', step: 'created' }]), { event: 'RETURNED' }, { event: 'TERMINATED' },
    ];
    const outcome = { classification: 'COMPLETED', result: { status: match ? 'CREATED' : 'NO_OP' },
      effects: match ? [{ step: 'created', capability: 'tasks.create', state: 'CONFIRMED' }] : [], trace: events.map((event, sequence) => ({ sequence, ...event })) };
    return { format: trusted.pins.modelRef.format === 'keir-dcm/3' ? 'keir-scenario/3' : 'keir-scenario/2', id, given,
      stubs: [{ ...read, response: { kind: 'SUCCESS', value: { id: 'task1', projectId, status, title: 'Example task', tags: [], priority: 'normal' } } },
        ...(match ? [{ ...write, response: { kind: 'SUCCESS', value: { id: 'task2' }, effect: 'CONFIRMED' } }] : [])],
      expect: { outcome, calls: match ? [read, write] : [read], consumption: consumeTaskEffect(outcome, host) } };
  });
  for (const [id, kind, code] of [
    ['missing-task', 'BUSINESS_REJECTION', 'TASK_NOT_FOUND'],
    ['access-denied', 'BUSINESS_REJECTION', 'ACCESS_DENIED'],
    ['read-unavailable', 'TRANSIENT_FAILURE', 'ADAPTER_TRANSIENT'],
  ]) {
    const classification = kind === 'BUSINESS_REJECTION' ? kind : 'FAILED', error = { code, path: '/steps/1' };
    const outcome = { classification, error, effects: [], trace: [
      { sequence: 0, event: 'INVOCATION_START' }, { sequence: 1, event: 'STEP_START', step: 'eligibleProject' },
      { sequence: 2, event: 'VALUE_BOUND', step: 'eligibleProject' }, { sequence: 3, event: 'STEP_START', step: 'source' },
      { sequence: 4, event: 'CALL_DISPATCHED', step: 'source', capability: 'tasks.get' }, { sequence: 5, event: 'TERMINATED', code },
    ] };
    rows.push({ format: trusted.pins.modelRef.format === 'keir-dcm/3' ? 'keir-scenario/3' : 'keir-scenario/2', id, given,
      stubs: [{ ...read, response: kind === 'BUSINESS_REJECTION' ? { kind, code } : { kind } }],
      expect: { outcome, calls: [read], consumption: consumeTaskEffect(outcome, host) } });
  }
  return rows.map(row => JSON.stringify(row, null, 2));
}
