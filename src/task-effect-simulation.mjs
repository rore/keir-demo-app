import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { admitArtifact, definitionForPins, digest, hostBindings, json, TASK_HOOK } from './extension-catalog.mjs';
import { decodeKeirScenario } from './keir-scenario.mjs';

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
  requireThat(trusted.pins.hook === TASK_HOOK && host.definitionId === trusted.definitionId
    && host.dcmBytes instanceof Uint8Array && Buffer.from(host.dcmBytes).equals(trusted.dcmBytes));
  return trusted;
}
function validateOutcome(outcome, dcm) {
  closed(outcome, ['classification', 'effects', 'trace'], ['result', 'error']);
  requireThat(classifications.includes(outcome.classification));
  array(outcome.effects, 1); array(outcome.trace, 64);
  requireThat(outcome.trace.length >= 2);
  const entry = dcm.entrypoints[TASK_HOOK];
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

function reported(value) {
  const { classification, effects, result, error } = value;
  return { status: 'REPORTED', classification, ...(own(value, 'result') ? { result } : {}),
    ...(own(value, 'error') ? { error } : {}), effects };
}

// A program label never establishes a native effect; the runtime ledger and trace do.
export function consumeTaskEffect(outcome, host) {
  try {
    const trusted = checkedHost(host), value = snapshot(outcome);
    validateOutcome(value, JSON.parse(trusted.dcmBytes));
    return reported(value);
  } catch { return { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' }; }
}
function scalarRecord(value, fields) {
  closed(value, fields);
  for (const field of fields) requireThat(bounded(value[field]));
}
function validateCall(call, dcm, stub = false) {
  requireThat(own(dcm.capabilities, call.capability) && call.version === dcm.capabilities[call.capability].version);
  scalarRecord(call.args, call.capability === 'tasks.get' ? ['taskId'] : ['projectId', 'title']);
  scalarRecord(call.protectedArgs, ['actorId']);
  requireThat(call.protectedArgs.actorId === fixtureActor);
  if (!stub) return;
  const response = call.response, write = call.capability === 'tasks.create';
  if (response?.kind === 'SUCCESS') {
    closed(response, ['kind', 'value', ...(write ? ['effect'] : [])]);
    const fields = Object.keys(dcm.types[dcm.capabilities[call.capability].result].fields);
    closed(response.value, fields);
    for (const field of fields) {
      const value = response.value[field];
      requireThat(bounded(value) && (field !== 'title' || value.trim() && value.length <= 120));
    }
    if (!write) requireThat(response.value.id === call.args.taskId);
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
  rows.forEach(({ given, stubs, expect }, index) => {
    try {
      requireThat(fixtures.includes(given.fixture));
      scalarRecord(given.input, ['taskId']);
      stubs.forEach(call => validateCall(call, dcm, true));
      expect.calls.forEach(call => validateCall(call, dcm));
      validateOutcome(expect.outcome, dcm);
      requireThat(same(reported(expect.outcome), expect.consumption));
      requireThat(same(stubs.map(({ response, ...call }) => call), expect.calls));
      const targets = calls => calls.map(({ step, capability }) => ({ step, capability }));
      const dispatched = expect.outcome.trace.filter(event => event.event === 'CALL_DISPATCHED');
      requireThat(same(targets(dispatched), targets(expect.calls)));
      requireThat(expect.outcome.trace.every(event => event.event !== 'GUARD_EVALUATED' || event.taken
        || !dispatched.some(call => call.step === event.step)));
      requireThat(expect.calls.every(call => artifact.steps.some(step => step.id === call.step && step.op === 'CALL' && step.capability === call.capability)));
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
          && context.deadline.clock.nowMs() === now && context.deadline.expiresAtMs === deadline.expiresAtMs && protectedArgs.actorId === fixtureActor);
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
  const native = await invokeProgram(selection.prepared, row.given.input, { bindings: hostBindings(artifactBytes, fixtureActor), requestKey: key, event, deadline });
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
    requireThat(artifactBytes instanceof Uint8Array && artifactBytes.byteLength <= 1_048_576);
    artifactBytes = Buffer.from(artifactBytes);
    ({ rows, trusted } = preflight(artifactBytes, host, scenarios));
    identity = { ...trusted.pins, artifactDigest: digest(artifactBytes), simulator: 'daymark-task-effect-simulation/1', fixture: 'daymark-task-effect-fixtures/1' };
  } catch { return { format: 'daymark-task-effect-simulation/1', status: 'FAIL', identity, reports, mismatches: [{ stage: 'SCENARIO', code: 'INVALID' }] }; }
  for (const row of rows) {
    if (signal?.aborted) return { format: 'daymark-task-effect-simulation/1', status: 'FAIL', identity, reports, mismatches: [{ stage: 'EXECUTION', code: 'CANCELLED' }] };
    try { reports.push(await runCase(artifactBytes, trusted, row, signal)); }
    catch { reports.push({ id: row.id, label: row.id, expected: row.expect, report: { status: 'FAIL', mismatches: [{ stage: 'SETUP', code: 'UNAVAILABLE' }] } }); }
  }
  return { format: 'daymark-task-effect-simulation/1', status: reports.every(item => item.report.status === 'PASS') ? 'PASS' : 'FAIL', identity, reports };
}

// Lifecycle and native commit guards must validate the same saved proof, including its actual reports.
export function taskEffectProofMatches(revision, authored, proof, host) {
  try {
    const pins = JSON.parse(revision.identity);
    if (pins.hook !== TASK_HOOK || own(pins, 'profile') || own(pins, 'qualification')
        || Object.entries(host.pins).some(([name, value]) => !same(pins[name], value))
        || pins.fixture !== 'daymark-task-effect-fixtures/1' || revision.identity !== json(pins)
        || pins.rawSourceDigest !== digest(authored.source) || pins.artifactDigest !== digest(authored.artifact)
        || pins.suiteDigest !== digest(authored.suite) || proof.owner_id !== revision.owner_id
        || proof.revision_id !== revision.id || proof.identity !== revision.identity || proof.passed !== 1
        || Buffer.byteLength(proof.payload) > 131072) return false;
    // Native guards re-read proof rows against the deployment captured by their service.
    const texts = JSON.parse(authored.suite), scenarios = decodeTaskEffectScenarios(texts);
    const artifact = JSON.parse(Buffer.from(authored.artifact).toString('utf8'));
    if (artifact.format !== 'keir-artifact/1' || own(artifact, 'profile') || artifact.compiler !== pins.compiler
        || artifact.entrypoint !== pins.hook || !same(artifact.modelRef, pins.modelRef) || !same(artifact.environment, pins.environment)
        || !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest) || pins.compiledSourceDigest !== artifact.sourceDigest) return false;
    validateRows(scenarios, artifact, host);
    const versions = { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator: 'daymark-task-effect-simulation/1' };
    const suiteIdentity = digest(json({ ...versions, simulator: revision.identity,
      cases: scenarios.map((scenario, index) => ({ id: scenario.id, digest: digest(texts[index]) })) }));
    const payload = JSON.parse(proof.payload);
    return proof.suite_identity === suiteIdentity
      && json(payload.identity) === json({ dependencies: pins, ...versions, suiteDigest: suiteIdentity })
      && payload.reports.length === scenarios.length && payload.reports.every((item, index) => {
        const scenario = scenarios[index], expected = scenario.expect.outcome, report = item.report;
        const createdTasks = expected.effects?.some(effect => effect.state === 'UNKNOWN') ? null
          : expected.effects?.some(effect => effect.state === 'CONFIRMED')
            ? scenario.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title })) : [];
        return item.id === scenario.id && item.label === scenario.id
          && json(item.expected) === json({ outcome: expected, calls: scenario.expect.calls, consumption: scenario.expect.consumption, createdTasks })
          && report.status === 'PASS' && Array.isArray(report.mismatches) && report.mismatches.length === 0
          && same(report.native, expected) && same(report.calls, scenario.expect.calls)
          && same(report.consumption, scenario.expect.consumption);
      });
  } catch { return false; }
}

// Format guidance only. Customer project and title must be resolved and authored separately.
export function taskEffectSyntax(host) {
  const trusted = checkedHost(host), model = JSON.parse(trusted.dcmBytes);
  return JSON.stringify({ language: 'keir/1', domain: { ...model.domain, fingerprint: trusted.pins.modelDigest }, entrypoint: TASK_HOOK,
    name: 'format-only-completion-example', steps: [
      { id: 'eligibleProject', let: { literal: 'project1', type: 'ProjectId' } },
      { id: 'source', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
      { id: 'eligible', let: { cel: 'source.status == "COMPLETED" && source.projectId == eligibleProject' } },
      { id: 'created', call: 'tasks.create', when: 'eligible', args: { projectId: { cel: 'eligibleProject' }, title: { literal: 'Example follow-up task' } } },
    ], return: { record: { status: { cel: 'eligible ? "CREATED" : "NO_OP"' } } } }, null, 2);
}
export function taskEffectScenarioExamples(host) {
  const model = JSON.parse(checkedHost(host).dcmBytes), capability = model.capabilities['tasks.get'];
  const read = { step: 'source', capability: 'tasks.get', version: capability.version, args: { taskId: 'task1' }, protectedArgs: { actorId: fixtureActor } };
  const rows = [
    ['matching-project', 'project1', 'COMPLETED', true],
    ['other-project', 'project2', 'COMPLETED', false],
    ['unfinished-task', 'project1', 'OPEN', false],
  ].map(([id, projectId, status, match]) => {
    const write = { step: 'created', capability: 'tasks.create', version: '1', args: { projectId: 'project1', title: 'Example follow-up task' }, protectedArgs: { actorId: fixtureActor } };
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
    return { format: 'keir-scenario/1', id, given: { input: { taskId: 'task1' }, fixture: 'normal' },
      stubs: [{ ...read, response: { kind: 'SUCCESS', value: { id: 'task1', projectId, status, title: 'Example task' } } },
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
    rows.push({ format: 'keir-scenario/1', id, given: { input: { taskId: 'task1' }, fixture: 'normal' },
      stubs: [{ ...read, response: kind === 'BUSINESS_REJECTION' ? { kind, code } : { kind } }],
      expect: { outcome, calls: [read], consumption: consumeTaskEffect(outcome, host) } });
  }
  return rows.map(row => JSON.stringify(row, null, 2));
}
