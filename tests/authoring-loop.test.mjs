import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createAuthoringProvider } from '../src/authoring-provider.mjs';
import { createAuthoringState, runAuthoringTurn } from '../src/authoring-agent.mjs';
import { checkAuthoringProvider } from '../scripts/check-authoring-provider.mjs';
import { createQualificationHost } from '../scripts/authoring-qualification-host.mjs';

const hash = digit => 'sha256:' + digit.repeat(64);
const env = provider => ({ KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
  KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-openai-key', ANTHROPIC_API_KEY: 'synthetic-anthropic-key' });
const source = '{"format":"keir/v0","independent":"synthetic source bytes"}';
const cases = [JSON.stringify({ format: 'keir-read-simulation/1', id: 'independent', input: { taskId: 'sample' }, stubs: [],
  expect: { calls: [], outcome: { classification: 'COMPLETED', result: { classification: 'PENDING' } }, consumption: { status: 'DISPLAYED', code: 'PENDING' } } })];
function scenario(providerName, { clarify = true, wrong = false } = {}) {
  const requests = [], events = [];
  const selection = { revisionId: 'approvedA', generation: 7, evidenceId: 'EA' };
  let current = { revisionId: 'approvedA', draftVersion: 0, suiteDigest: hash('0') };
  let compiled = false;
  const steps = [
    ['discover_catalog', {}], ...(clarify ? [['ask_clarification', { question: 'Which classification should open tasks show?' }]] : []),
    ['compile_draft', { sourceJson: 'invalid candidate', expectedDraftVersion: 0 }],
    ['compile_draft', { sourceJson: source, expectedDraftVersion: 0 }],
    ['propose_scenarios', { revisionId: 'compiledB', cases, expectedDraftVersion: 1 }],
    ['simulate_draft', { revisionId: 'reviewB', expectedDraftVersion: 2 }],
    ['offer_review', { summary: 'Review the independent synthetic case; other inputs are untested.' }],
  ];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const index = requests.length;
    requests.push({ url, body });
    const [name, args] = steps[index];
    assert.equal(body.tools.some(tool => ['approve', 'activate'].includes(tool.name)), false);
    if (index > 0) {
      const last = providerName === 'openai'
        ? body.input.filter(item => item.type === 'function_call_output').at(-1)
        : body.messages.filter(item => item.role === 'user').at(-1).content[0];
      assert.equal(providerName === 'openai' ? last.call_id : last.tool_use_id, 'tool' + index);
    }
    const response = providerName === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning', id: 'reason' + index, encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'tool' + (index + 1) }], usage: { input_tokens: 100, output_tokens: 100 } }
      : { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'private', signature: 'opaque' },
        { type: 'tool_use', id: 'tool' + (index + 1), name, input: args }], usage: { input_tokens: 100, output_tokens: 100 } };
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
  // These are injected host doubles: actual compiler/lifecycle qualification belongs to integration.
  const host = {
    readDraft: () => ({ ...current, selection }),
    discover: () => ({ profile: 'keir-read/2', capabilities: ['tasks.get'], draftVersion: current.draftVersion }),
    compile: (bytes, expected) => {
      assert.equal(expected, current.draftVersion); events.push(['compile', bytes.toString()]);
      if (bytes.toString() !== source) return { diagnostics: [{ code: 'SOURCE_INVALID', path: '/source' }] };
      compiled = true; current = { revisionId: 'compiledB', draftVersion: 1, suiteDigest: null }; return { ...current };
    },
    proposeScenarios: (id, originals, expected) => {
      assert.equal(compiled, true); assert.equal(id, 'compiledB'); assert.equal(expected, 1);
      assert.deepEqual(originals, cases); assert.notEqual(originals, cases); events.push(['scenarios', id]);
      current = { revisionId: 'reviewB', draftVersion: 2, suiteDigest: hash('1') }; return { ...current };
    },
    simulate: (id, expected) => {
      assert.equal(id, 'reviewB'); assert.equal(expected, 2); events.push(['simulate', id]);
      return { ...current, evidenceId: 'EB', simulationSuiteIdentity: hash('2'), summary: { statuses: [wrong ? 'MISMATCH' : 'PASS'] } };
    },
    readEvidence: () => ({ ...current, evidenceId: 'EB', simulationSuiteIdentity: hash('2'), eligible: !wrong, summary: { statuses: [wrong ? 'MISMATCH' : 'PASS'] } }),
  };
  const config = readAuthoringConfig(env(providerName));
  const context = { ownerId: 'synthetic-owner', sessionId: 'synthetic-session', conversationId: 'synthetic-conversation', runId: 'synthetic-run',
    current: () => true, checkpoint: () => {}, budget: { remainingMicros: config.maxMicros } };
  return { provider: createAuthoringProvider(config, { fetchImpl }), host, context, requests, selection, events, fetchImpl };
}

for (const name of ['openai', 'anthropic']) test(`${name} native protocol drives the actual loop through pause/reload/repair/exact review`, async () => {
  const f = scenario(name); let state = createAuthoringState(f.context);
  const first = await runAuthoringTurn({ ...f, state, input: { id: 'request', text: 'Make task advice.', expectedVersion: 0 } });
  assert.equal(first.status, 'AWAITING_USER'); assert.equal(f.requests.length, 2);
  state = JSON.parse(JSON.stringify(state)); // owner persistence can restore private native continuation.
  const result = await runAuthoringTurn({ ...f, state, input: { id: 'answer', text: 'PENDING for open tasks.', expectedVersion: 1 } });
  assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.revisionId, 'reviewB');
  assert.equal(result.review.evidenceId, 'EB'); assert.equal(result.review.eligible, true);
  assert.deepEqual(f.selection, { revisionId: 'approvedA', generation: 7, evidenceId: 'EA' });
  assert.deepEqual(f.events, [['compile', 'invalid candidate'], ['compile', source], ['scenarios', 'compiledB'], ['simulate', 'reviewB']]);
  assert.equal(state.counts.calls, 7); assert.equal(state.counts.compiles, 2); assert.equal(state.handles.draftVersion, 2);
  assert.equal(state.usage.inputTokens, 700); assert.equal(state.usage.outputTokens, 700);
  assert.equal(state.usage.reservedMicros, 7 * f.provider.reserveMicros);
  assert.equal(JSON.stringify(result).includes('opaque'), false, 'private reasoning is never a UI event');
});

test('wrong independently supplied expectation stays ineligible and active approved snapshot is unchanged', async () => {
  const f = scenario('openai', { clarify: false, wrong: true }); const state = createAuthoringState(f.context);
  const result = await runAuthoringTurn({ ...f, state, input: { id: 'request', text: 'Propose cases.', expectedVersion: 0 } });
  assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.eligible, false);
  assert.deepEqual(result.review.summary, { statuses: ['MISMATCH'] });
  assert.deepEqual(f.selection, { revisionId: 'approvedA', generation: 7, evidenceId: 'EA' });
  assert.equal(f.events.filter(item => item[0] === 'scenarios').length, 1, 'no automatic expectation rewrite');
});

test('qualification is explicitly opt-in and requires the operator host fixture; default CLI cannot call a provider', async () => {
  const neverRead = { get KEIR_AI_PROVIDER() { throw Error('must not inspect configuration'); } };
  assert.deepEqual(await checkAuthoringProvider({ env: neverRead }), { status: 'NOT_RUN', code: 'LIVE_OPT_IN_REQUIRED' });
  assert.deepEqual(await checkAuthoringProvider({ live: true, env: neverRead }), { status: 'NOT_RUN', code: 'HOST_FIXTURE_REQUIRED' });
  const cli = spawnSync(process.execPath, ['scripts/check-authoring-provider.mjs'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout), { status: 'NOT_RUN', code: 'LIVE_OPT_IN_REQUIRED' });
});

test('opt-in harness returns only bounded identity/counters and requires configured keys and cap', async () => {
  const f = scenario('anthropic', { clarify: false });
  const result = await checkAuthoringProvider({ live: true, env: env('anthropic'), ...f,
    inputs: [{ id: 'request', text: 'Use the synthetic case.' }] });
  assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.evidenceId, 'EB');
  assert.equal(result.model, 'claude-haiku-5-5'); assert.equal(result.counts.calls, 6);
  assert.equal(JSON.stringify(result).includes('synthetic-anthropic-key'), false);
  assert.equal(JSON.stringify(result).includes('opaque'), false);
  const unavailable = await checkAuthoringProvider({ live: true, env: {}, ...scenario('openai'), inputs: [{ id: 'request', text: 'No config.' }] });
  assert.deepEqual(unavailable, { status: 'NOT_RUN', code: 'AI_NOT_CONFIGURED' });
});

test('project qualification fixture uses isolated durable service and remains inert without opt-in', async () => {
  let requests = 0;
  const fixture = createQualificationHost();
  const options = { ...fixture, env: env('openai'), fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'No review was produced.' }] }], usage: { input_tokens: 1, output_tokens: 1 } }),
    { headers: { 'content-type': 'application/json' } });
  } };
  assert.equal((await checkAuthoringProvider(options)).status, 'NOT_RUN');
  assert.equal(requests, 0);
  const result = await checkAuthoringProvider({ ...options, live: true });
  assert.equal(result.status, 'IDLE'); assert.equal(result.counts.calls, 1);
  assert.equal(result.usage.reservedMicros, 319488); assert.equal(requests, 1);
  assert.equal(Object.hasOwn(result, 'review'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-openai-key'), false);
});

test('qualification examples pass the actual permitted authored simulator independently of provider output', async () => {
  const fixture = createQualificationHost();
  const cases = JSON.parse(fixture.inputs[0].text.split('Independent cases: ')[1]);
  assert.equal(cases.length, 5);
  assert.equal(cases.some(value => JSON.parse(value).id === 'host-denied'), false);
  const db = openData(':memory:');
  try {
    // Packaging/compilation is covered separately; this checks the fixture's independent truth.
    const compiler = { compile: async () => ({ artifact: readFileSync(new URL('../extensions/task-read/maya.json', import.meta.url)), diagnostics: [] }) };
    const lifecycle = createLifecycle(db, { compiler });
    let draft = await lifecycle.compile('sam', { source: readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8'), draftVersion: 0 }, () => {});
    draft = await lifecycle.proposeScenarios('sam', { revisionId: draft.revisionId, cases, draftVersion: draft.draftVersion }, () => {});
    draft = await lifecycle.simulate('sam', { revisionId: draft.revisionId, draftVersion: draft.draftVersion }, () => {});
    const proof = lifecycle.evidence('sam', draft.evidence.id);
    assert.equal(proof.passed, true);
    assert.deepEqual(proof.reports.map(item => item.report.status), Array(5).fill('PASS'));
  } finally { db.close(); }
});
