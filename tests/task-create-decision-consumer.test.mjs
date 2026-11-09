import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { createTaskDecisionConsumer, taskEffectSyntax } from '../src/task-effect-simulation.mjs';

let consume, allowed, denied;
before(async () => {
  const host = loadHost('TaskBeforeCreate'), model = JSON.parse(host.dcmBytes);
  const compilation = await createCompiler().compile(Buffer.from(taskEffectSyntax(host)), { definition: host });
  assert.ok(compilation.artifact, JSON.stringify(compilation.diagnostics));
  const implementations = Object.fromEntries(Object.entries(model.capabilities).map(([id, capability]) => [id, {
    version: capability.version, mode: 'simulation', keyType: model.hostKey.type,
    invoke() { assert.fail('The input-only decision must dispatch no capability'); },
  }]));
  const binding = bindModel(host.dcmBytes, implementations);
  assert.ok(binding.boundModel, JSON.stringify(binding.diagnostic));
  const preparation = prepareProgram(compilation.artifact, binding.boundModel);
  assert.ok(preparation.prepared, JSON.stringify(preparation.diagnostic));
  const invoke = priority => invokeProgram(preparation.prepared,
    { projectId: 'project1', priority, tags: [], hasNotes: false, hasDueDate: false },
    { bindings: {}, requestKey: Object.freeze({}), event: { id: 'attempt1', source: 'project1' },
      deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } });
  allowed = await invoke('normal'); denied = await invoke('high');
  consume = createTaskDecisionConsumer(host);
});

test('decision consumption preserves the complete typed result without claiming a native save', () => {
  assert.deepEqual(consume(allowed), { status: 'ALLOWED', result: { decision: 'ALLOW', message: '' } });
  assert.deepEqual(consume(denied), { status: 'DENIED', result: { decision: 'DENY', message: 'Add notes for this task.' } });
  assert.deepEqual(allowed.effects, []); assert.deepEqual(denied.effects, []);
});

for (const [name, alter] of [
  ['unknown classification', value => { value.classification = 'SAVED'; }],
  ['handled rejection returning allow', value => {
    value.classification = 'BUSINESS_REJECTION'; value.error = { code: 'ACCESS_DENIED', path: '/steps/0' };
    value.trace.at(-1).code = 'ACCESS_DENIED';
  }],
  ['missing message', value => { delete value.result.message; }],
  ['unknown decision', value => { value.result.decision = 'CONTINUE'; }],
  ['extra result field', value => { value.result.saved = true; }],
  ['oversize UTF8 message', value => { value.result.message = '界'.repeat(86); }],
  ['malformed Unicode', value => { value.result.message = '\ud800'; }],
  ['extra outcome field', value => { value.nativeSaved = true; }],
  ['completed error', value => { value.error = { code: 'ACCESS_DENIED', path: '' }; }],
  ['nonempty effect ledger', value => { value.effects.push({ step: 'needsDetails', capability: 'tasks.create', state: 'CONFIRMED' }); }],
  ['missing return trace', value => { value.trace = value.trace.filter(row => row.event !== 'RETURNED'); }],
  ['duplicate step identity', value => { value.trace.splice(3, 0, ...structuredClone(value.trace.slice(1, 3))); }],
  ['mismatched read completion', value => { value.trace = [
    { event: 'INVOCATION_START' }, { event: 'STEP_START', step: 'read' },
    { event: 'CALL_DISPATCHED', step: 'read', capability: 'tasks.get' },
    { event: 'CALL_SUCCEEDED', step: 'read', capability: 'tasks.openMatch' },
    { event: 'RETURNED' }, { event: 'TERMINATED' },
  ]; }],
]) test('decision consumption blocks ' + name, () => {
  const value = structuredClone(allowed); alter(value);
  value.trace.forEach((event, sequence) => { event.sequence = sequence; });
  assert.deepEqual(consume(value), { status: 'BLOCKED' });
});

test('decision consumption rejects executable object shapes without evaluating them', () => {
  const value = structuredClone(allowed);
  let reads = 0;
  Object.defineProperty(value.result, 'message', { enumerable: true, get() { reads++; return ''; } });
  assert.deepEqual(consume(value), { status: 'BLOCKED' });
  assert.equal(reads, 0);
  assert.deepEqual(consume(new Proxy(allowed, { get() { assert.fail('A proxy must not be inspected'); } })), { status: 'BLOCKED' });
  const nested = structuredClone(allowed);
  nested.trace = new Proxy(nested.trace, { get() { assert.fail('A proxy array must not be inspected'); } });
  assert.deepEqual(consume(nested), { status: 'BLOCKED' });
});
