import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { definitionForPins, historicalDefinitionForPins, digest, hostBindings, json, TASK_HOOK } from './extension-catalog.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const bounded = (value, max = 256) => typeof value === 'string' && value.isWellFormed() && value.length > 0 && Buffer.byteLength(value) <= max;
function requireThat(condition) { if (!condition) throw new Error('Invalid task effect data'); }
function closed(value, required, optional = []) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const names = Reflect.ownKeys(value);
  requireThat(names.length <= required.length + optional.length && required.every(name => own(value, name))
    && names.every(name => typeof name === 'string' && (required.includes(name) || optional.includes(name))
      && Object.getOwnPropertyDescriptor(value, name)?.enumerable && own(Object.getOwnPropertyDescriptor(value, name), 'value')));
}
function array(value, max) {
  requireThat(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
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
function checkedHost(host, historical = false) {
  const trusted = historical ? historicalDefinitionForPins(host.pins) : definitionForPins(host.pins);
  requireThat(trusted.pins.hook === TASK_HOOK && host.definitionId === trusted.definitionId
    && host.dcmBytes instanceof Uint8Array && Buffer.from(host.dcmBytes).equals(trusted.dcmBytes));
  return trusted;
}
function validateOutcome(outcome, host) {
  closed(outcome, ['classification', 'effects', 'trace'], ['result', 'error']);
  requireThat(classifications.includes(outcome.classification));
  array(outcome.effects, 1); array(outcome.trace, 64);
  requireThat(outcome.trace.length >= 2);
  const dcm = JSON.parse(host.dcmBytes), entry = dcm.entrypoints[TASK_HOOK];
  if (own(outcome, 'result')) {
    closed(outcome.result, ['status']);
    requireThat(dcm.types[dcm.types[entry.output].fields.status].values.includes(outcome.result.status));
  }
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

// A program label never establishes a native effect; the runtime ledger and trace do.
export function consumeTaskEffect(outcome, host) {
  try {
    const trusted = checkedHost(host, true), value = snapshot(outcome);
    validateOutcome(value, trusted);
    const { classification, effects, result, error } = value;
    return { status: 'REPORTED', classification, ...(own(value, 'result') ? { result } : {}),
      ...(own(value, 'error') ? { error } : {}), effects };
  } catch { return { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' }; }
}
function scalarRecord(value, fields) {
  closed(value, fields);
  for (const field of fields) requireThat(bounded(value[field]));
}
function validateCall(call, dcm, stub = false) {
  closed(call, ['step', 'capability', 'version', 'args', 'protectedArgs', ...(stub ? ['response'] : [])]);
  requireThat(step(call.step) && own(dcm.capabilities, call.capability) && call.version === dcm.capabilities[call.capability].version);
  scalarRecord(call.args, call.capability === 'tasks.get' ? ['taskId'] : ['projectId', 'title']);
  scalarRecord(call.protectedArgs, ['actorId']);
  if (!stub) return;
  const response = call.response, write = call.capability === 'tasks.create';
  if (response?.kind === 'SUCCESS') {
    closed(response, ['kind', 'value', ...(write ? ['effect'] : [])]);
    const fields = Object.keys(dcm.types[dcm.capabilities[call.capability].result].fields);
    closed(response.value, fields);
    for (const field of fields) {
      const value = response.value[field];
      // Native titles can exceed the runtime byte limit. Submit the full title to the runtime.
      requireThat(field === 'title' ? typeof value === 'string' && value.isWellFormed() && value.trim() && value.length <= 120 : bounded(value));
    }
    requireThat(write ? response.effect === 'CONFIRMED' : ['OPEN', 'COMPLETED'].includes(response.value.status));
  } else if (response?.kind === 'BUSINESS_REJECTION') {
    closed(response, ['kind', 'code', ...(write ? ['effect'] : [])]);
    requireThat(dcm.capabilities[call.capability].errors.includes(response.code) && (!write || response.effect === 'NONE'));
  } else if (response?.kind === 'TRANSIENT_FAILURE') {
    closed(response, ['kind', ...(write ? ['effect'] : [])]); requireThat(!write || response.effect === 'NONE');
  } else {
    closed(response, ['kind', 'effect']); requireThat(write && response.kind === 'UNKNOWN_COMMIT' && response.effect === 'UNKNOWN');
  }
}
function scenario(value, host) {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    requireThat(typeof value !== 'string' || value.isWellFormed());
    const raw = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    requireThat(raw.length <= 65_536 && !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), stack = [];
    // JSON.parse discards duplicate fields, so reject them before shape validation.
    for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/gs)) {
      const parent = stack.at(-1);
      if (token === '{' || token === '[') {
        requireThat(stack.length < 16); stack.push(token === '{' ? { keys: new Set(), key: true } : {});
      } else if (token === '}' || token === ']') stack.pop();
      else if (token === ',' && parent?.keys) parent.key = true;
      else if (token.startsWith('"') && parent?.key) {
        const name = JSON.parse(token); requireThat(!parent.keys.has(name)); parent.keys.add(name); parent.key = false;
      }
    }
    value = JSON.parse(text);
  }
  const row = snapshot(value), dcm = JSON.parse(host.dcmBytes);
  closed(row, ['format', 'id', 'given', 'stubs', 'expect']);
  requireThat(row.format === 'keir-scenario/effect-4' && bounded(row.id, 64) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.id));
  closed(row.given, ['input', 'fixture']); scalarRecord(row.given.input, ['taskId']); requireThat(fixtures.includes(row.given.fixture));
  array(row.stubs, 4); row.stubs.forEach(call => validateCall(call, dcm, true));
  closed(row.expect, ['outcome', 'calls', 'consumption']); array(row.expect.calls, 4);
  row.expect.calls.forEach(call => validateCall(call, dcm)); validateOutcome(row.expect.outcome, host);
  requireThat(same(consumeTaskEffect(row.expect.outcome, host), row.expect.consumption));
  return row;
}
export function validateTaskEffectScenarios(host, scenarios) {
  const trusted = checkedHost(host);
  array(scenarios, 16); requireThat(scenarios.length > 0);
  const rows = scenarios.map(value => scenario(value, trusted));
  requireThat(new Set(rows.map(row => row.id)).size === rows.length);
  return rows;
}
function observations(calls, outcome, consumption, violations) {
  const writes = calls.filter(call => call.capability === 'tasks.create');
  if (consumption.status !== 'REPORTED' || violations.some(item => item.stage === 'STUB')) return { effect: 'NOT_OBSERVED', createdTasks: null };
  if (!writes.length) return { effect: 'NONE', createdTasks: [] };
  const state = outcome.effects[0]?.state;
  if (state === 'CONFIRMED') return { effect: state, createdTasks: writes.map(call => ({ projectId: call.args.projectId, title: call.args.title })) };
  return { effect: state ?? 'NOT_OBSERVED', createdTasks: state === 'NONE' ? [] : null };
}
async function runCase(artifactBytes, host, row, signal) {
  const captures = [], violations = [], fixture = row.given.fixture;
  let used = 0, now = 0;
  const key = Object.freeze(Object.create(null));
  const event = Object.freeze({ id: 'example-event', source: fixture === 'wrong-origin' ? 'other-task' : row.given.input.taskId });
  const deadline = { clock: { nowMs: () => now }, expiresAtMs: 1000 }, model = JSON.parse(host.dcmBytes);
  const add = (stage, code, ordinal = 0) => { if (violations.length < 8) violations.push({ stage, code, ordinal }); };
  const invokers = Object.fromEntries(Object.entries(model.capabilities).map(([capability, cap]) => [capability, {
    version: cap.version, mode: 'simulation', keyType: model.hostKey.type,
    invoke(args, protectedArgs, remainingMs, context) {
      const capture = snapshot({ capability, version: cap.version, args, protectedArgs }); captures.push(capture);
      const stub = row.stubs[used];
      try {
        requireThat(Number.isSafeInteger(remainingMs) && remainingMs > 0 && context.requestKey === key && same(context.event, event)
          && context.deadline.clock.nowMs() === now && context.deadline.expiresAtMs === deadline.expiresAtMs && protectedArgs.actorId === 'user1');
        requireThat(stub && same(capture, { capability: stub.capability, version: stub.version, args: stub.args, protectedArgs: stub.protectedArgs }));
        if (capability === 'tasks.get') requireThat(stub.response.kind !== 'SUCCESS' || stub.response.value.id === args.taskId);
        used++;
      } catch { add('STUB', 'STUB_MISMATCH', captures.length); throw new Error('Task effect fixture mismatch'); }
      if (signal?.aborted || fixture === 'invocation-denied' || fixture === 'invalid-key' || event.source !== row.given.input.taskId
          || fixture === 'write-denied' && capability === 'tasks.create') {
        return { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', ...(capability === 'tasks.create' ? { effect: 'NONE' } : {}) };
      }
      if (fixture === 'read-throws' && capability === 'tasks.get' || fixture === 'lost-response' && capability === 'tasks.create')
        throw new Error('Simulated unavailable response');
      if (capability === 'tasks.create' && fixture === 'response-expired') now = 1000;
      if (capability === 'tasks.create' && fixture === 'response-bad-clock') now = -1;
      return snapshot(stub.response);
    },
  }]));
  const binding = bindModel(host.dcmBytes, invokers);
  requireThat(!binding.diagnostic);
  const selection = prepareProgram(artifactBytes, binding.boundModel);
  requireThat(!selection.diagnostic);
  const native = await invokeProgram(selection.prepared, row.given.input, { bindings: hostBindings(artifactBytes, 'user1'), requestKey: key, event, deadline });
  const dispatches = native.trace.filter(item => item.event === 'CALL_DISPATCHED');
  if (dispatches.length !== captures.length || used !== row.stubs.length) add('STUB', 'STUB_COUNT_MISMATCH');
  const calls = captures.map((capture, ordinal) => {
    const dispatch = dispatches[ordinal];
    if (!dispatch || dispatch.capability !== capture.capability || dispatch.step !== row.stubs[ordinal]?.step) add('STUB', 'DISPATCH_MISMATCH', ordinal + 1);
    return { step: dispatch?.step ?? '', ...capture };
  });
  const consumption = consumeTaskEffect(native, host);
  if (!same(native, row.expect.outcome)) add('OUTCOME', 'MISMATCH');
  if (!same(calls, row.expect.calls)) add('CALLS', 'MISMATCH');
  if (!same(consumption, row.expect.consumption)) add('CONSUMPTION', 'MISMATCH');
  const read = row.stubs.find(call => call.capability === 'tasks.get' && call.response.kind === 'SUCCESS' && call.response.value.id === row.given.input.taskId);
  const expectedEffect = row.expect.outcome.effects[0]?.state;
  return { id: row.id, label: row.id, expected: { ...row.expect, createdTasks: expectedEffect === 'UNKNOWN' ? null : expectedEffect === 'CONFIRMED'
    ? row.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title })) : [] }, report: {
    status: violations.length ? 'FAIL' : 'PASS', native, consumption, calls, mismatches: violations,
    scenario: { task: { id: row.given.input.taskId, title: read?.response.value.title ?? 'Example task',
      ...(read ? { status: read.response.value.status, projectId: read.response.value.projectId } : {}) } },
    observed: observations(calls, native, consumption, violations),
  } };
}

export async function runTaskEffectSimulation({ artifactBytes, host, scenarios, signal } = {}) {
  let trusted, identity = {}, rows;
  const reports = [];
  try {
    requireThat(signal === undefined || signal instanceof AbortSignal);
    trusted = checkedHost(host);
    requireThat(artifactBytes instanceof Uint8Array && artifactBytes.byteLength <= 1_048_576);
    artifactBytes = Buffer.from(artifactBytes);
    identity = { ...trusted.pins, artifactDigest: digest(artifactBytes), simulator: 'daymark-task-effect-simulation/1', fixture: 'daymark-task-effect-fixtures/1' };
    rows = validateTaskEffectScenarios(trusted, scenarios);
  } catch { return { format: 'daymark-task-effect-simulation/1', status: 'FAIL', identity, reports, mismatches: [{ stage: 'SCENARIO', code: 'INVALID' }] }; }
  for (const row of rows) {
    if (signal?.aborted) return { format: 'daymark-task-effect-simulation/1', status: 'FAIL', identity, reports, mismatches: [{ stage: 'EXECUTION', code: 'CANCELLED' }] };
    try { reports.push(await runCase(artifactBytes, trusted, row, signal)); }
    catch { reports.push({ id: row.id, label: row.id, expected: row.expect, report: { status: 'FAIL', mismatches: [{ stage: 'SETUP', code: 'UNAVAILABLE' }] } }); }
  }
  return { format: 'daymark-task-effect-simulation/1', status: reports.every(item => item.report.status === 'PASS') ? 'PASS' : 'FAIL', identity, reports };
}

// Lifecycle and native commit guards must validate the same saved proof, including its actual reports.
export function taskEffectProofMatches(revision, authored, proof) {
  try {
    const pins = JSON.parse(revision.identity), host = historicalDefinitionForPins(pins);
    const artifact = JSON.parse(Buffer.from(authored.artifact).toString('utf8'));
    if (pins.hook !== TASK_HOOK || pins.fixture !== 'daymark-task-effect-fixtures/1' || revision.identity !== json(pins)
        || !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest) || pins.rawSourceDigest !== digest(authored.source)
        || pins.artifactDigest !== digest(authored.artifact) || pins.compiledSourceDigest !== artifact.sourceDigest
        || pins.suiteDigest !== digest(authored.suite) || proof.owner_id !== revision.owner_id
        || proof.revision_id !== revision.id || proof.identity !== revision.identity || proof.passed !== 1
        || Buffer.byteLength(proof.payload) > 131072) return false;
    const scenarios = JSON.parse(authored.suite).map(text => ({ text, scenario: JSON.parse(text) }));
    const versions = { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator: 'daymark-task-effect-simulation/1' };
    const suiteIdentity = digest(json({ ...versions, simulator: revision.identity,
      cases: scenarios.map(({ text, scenario }) => ({ id: scenario.id, digest: digest(text) })) }));
    const payload = JSON.parse(proof.payload);
    return scenarios.length > 0 && proof.suite_identity === suiteIdentity
      && json(payload.identity) === json({ dependencies: pins, ...versions, suiteDigest: suiteIdentity })
      && payload.reports.length === scenarios.length && payload.reports.every((item, index) => {
        const scenario = scenarios[index].scenario, expected = scenario.expect.outcome, report = item.report;
        const createdTasks = expected.effects?.some(effect => effect.state === 'UNKNOWN') ? null
          : expected.effects?.some(effect => effect.state === 'CONFIRMED')
            ? scenario.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title })) : [];
        return item.id === scenario.id && item.label === scenario.id
          && json(item.expected) === json({ outcome: expected, calls: scenario.expect.calls, consumption: scenario.expect.consumption, createdTasks })
          && report.status === 'PASS' && Array.isArray(report.mismatches) && report.mismatches.length === 0
          && json(report.native) === json(expected) && json(report.calls) === json(scenario.expect.calls)
          && json(report.consumption) === json(scenario.expect.consumption)
          && json(consumeTaskEffect(report.native, host)) === json(report.consumption);
      });
  } catch { return false; }
}

// Format guidance only. Customer project and title must be resolved and authored separately.
export function taskEffectSyntax(host) {
  const trusted = checkedHost(host), model = JSON.parse(trusted.dcmBytes);
  return JSON.stringify({ language: 'keir/v0', domain: { ...model.domain, fingerprint: trusted.pins.modelDigest }, entrypoint: TASK_HOOK,
    name: 'format-only-completion-example', steps: [
      { id: 'eligibleProject', let: { literal: 'project1', type: 'ProjectId' } },
      { id: 'source', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
      { id: 'eligible', let: { cel: 'source.status == "COMPLETED" && source.projectId == eligibleProject' } },
      { id: 'created', call: 'tasks.create', when: 'eligible', args: { projectId: { cel: 'eligibleProject' }, title: { literal: 'Example follow-up task' } } },
    ], return: { record: { status: { cel: 'eligible ? "CREATED" : "NO_OP"' } } } }, null, 2);
}
export function taskEffectScenarioExamples(host) {
  const model = JSON.parse(checkedHost(host).dcmBytes), capability = model.capabilities['tasks.get'];
  const withTitle = own(model.types[capability.result].fields, 'title');
  const read = { step: 'source', capability: 'tasks.get', version: capability.version, args: { taskId: 'task1' }, protectedArgs: { actorId: 'user1' } };
  const rows = [
    ['matching-project', 'project1', 'COMPLETED', true],
    ['other-project', 'project2', 'COMPLETED', false],
    ['unfinished-task', 'project1', 'OPEN', false],
  ].map(([id, projectId, status, match]) => {
    const write = { step: 'created', capability: 'tasks.create', version: '1', args: { projectId: 'project1', title: 'Example follow-up task' }, protectedArgs: { actorId: 'user1' } };
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
    return { format: 'keir-scenario/effect-4', id, given: { input: { taskId: 'task1' }, fixture: 'normal' },
      stubs: [{ ...read, response: { kind: 'SUCCESS', value: { id: 'task1', projectId, status, ...(withTitle && { title: 'Example task' }) } } },
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
    rows.push({ format: 'keir-scenario/effect-4', id, given: { input: { taskId: 'task1' }, fixture: 'normal' },
      stubs: [{ ...read, response: kind === 'BUSINESS_REJECTION' ? { kind, code } : { kind } }],
      expect: { outcome, calls: [read], consumption: consumeTaskEffect(outcome, host) } });
  }
  return rows.map(row => JSON.stringify(row, null, 2));
}
