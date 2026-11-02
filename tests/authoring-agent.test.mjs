import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORING_TOOLS, createAuthoringState, runAuthoringTurn } from '../src/authoring-agent.mjs';

const suite = 'sha256:' + '1'.repeat(64);
const call = (name, args = {}, id) => ({ name, arguments: args, ...(id && { id }) });
function fixture(steps = [], initial = {}) {
  const context = { ownerId: 'owner', sessionId: 'session', conversationId: 'conversation', runId: 'run',
    budget: { remainingMicros: 1000 }, current: () => true };
  const state = createAuthoringState(context);
  let draft = { revisionId: null, draftVersion: 0, suiteDigest: null, ...initial };
  let next = 0;
  const events = [], requests = [];
  const host = {
    readDraft: () => ({ ...draft }),
    discover: () => { events.push('discover'); return { profile: 'keir-read/2', capabilities: ['tasks.get'] }; },
    compile: (bytes, expected) => {
      events.push(['compile', bytes.toString(), expected]);
      if (bytes.toString() === 'bad') return { diagnostics: [{ code: 'SOURCE_INVALID', path: '/source' }] };
      assert.equal(expected, draft.draftVersion);
      draft = { revisionId: 'revision' + ++next, draftVersion: expected + 1, suiteDigest: null };
      return { ...draft };
    },
    proposeScenarios: (revision, bytes, expected) => {
      events.push(['scenarios', revision, JSON.parse(bytes), expected]);
      assert.equal(revision, draft.revisionId); assert.equal(expected, draft.draftVersion);
      draft = { revisionId: 'revision' + ++next, draftVersion: expected + 1, suiteDigest: suite };
      return { ...draft };
    },
    simulate: (revision, expected) => {
      events.push(['simulate', revision, expected]);
      return { ...draft, evidenceId: 'evidence', summary: { statuses: ['PASS'] } };
    },
    readEvidence: () => { events.push('readEvidence'); return { ...draft, evidenceId: 'evidence', eligible: true, summary: { statuses: ['PASS'] } }; },
  };
  const provider = { reserveMicros: 10, maxMicros: 1000, complete: async request => {
    requests.push(request);
    const item = steps.shift();
    const calls = item ? [{ id: 'call' + requests.length, ...item }] : [];
    return { calls, text: calls.length ? '' : 'Stopped honestly.', usage: { inputTokens: 10, outputTokens: 10 },
      continuation: { provider: 'fake', items: [{ calls }] } };
  } };
  const run = (options = {}) => runAuthoringTurn({ host, provider, context, state,
    input: { id: 'input' + (state.version + 1), text: 'Create a read-only rule.', expectedVersion: state.version }, ...options });
  return { context, state, host, provider, requests, events, run, setDraft: value => { draft = value; } };
}

test('real loop compiles, repairs, replaces scenarios, consumes returned IDs and offers only host evidence', async () => {
  const f = fixture([
    call('discover_catalog'), call('compile_draft', { sourceJson: 'bad', expectedDraftVersion: 0 }),
    call('compile_draft', { sourceJson: '{"program":"independent"}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'revision1', casesJson: '[{"id":"independent-expectation"}]', expectedDraftVersion: 1 }),
    call('simulate_draft', { revisionId: 'revision2', expectedDraftVersion: 2 }),
    call('offer_review', { summary: 'Review the exact tested cases and untested limits.' }),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'REVIEW_AVAILABLE');
  assert.deepEqual(result.review, { revisionId: 'revision2', draftVersion: 2, suiteDigest: suite,
    evidenceId: 'evidence', eligible: true, summary: { statuses: ['PASS'] } });
  assert.deepEqual(f.events, ['discover', ['compile', 'bad', 0], ['compile', '{"program":"independent"}', 0],
    ['scenarios', 'revision1', [{ id: 'independent-expectation' }], 1], ['simulate', 'revision2', 2], 'readEvidence']);
  assert.equal(f.state.handles.draftVersion, 2, 'simulation/review never advance version');
  assert.equal(f.context.budget.remainingMicros, 940);
  assert.deepEqual(JSON.parse(f.requests[2].toolResult.output).result.diagnostics, [{ code: 'SOURCE_INVALID', path: '/source' }]);
  assert.deepEqual(AUTHORING_TOOLS.map(tool => tool.name), ['discover_catalog', 'ask_clarification', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);
});

test('clarification pauses until real user input and retains counters and pending tool result', async () => {
  const f = fixture([call('ask_clarification', { question: 'What should an open task display?' })]);
  assert.equal((await f.run()).status, 'AWAITING_USER');
  assert.equal(f.requests.length, 1); assert.equal(f.state.counts.clarifications, 1);
  assert.equal((await f.run({ input: { id: 'answer', text: 'PENDING.', expectedVersion: 1 } })).status, 'IDLE');
  assert.equal(f.requests[1].input, 'PENDING.');
  assert.equal(JSON.parse(f.requests[1].toolResult.output).status, 'AWAITING_USER');
  assert.equal(f.state.counts.calls, 2);
  const spent = f.context.budget.remainingMicros;
  assert.equal((await f.run({ input: { id: 'answer', text: 'Replay.', expectedVersion: 2 } })).code, 'DUPLICATE_INPUT');
  assert.equal((await f.run({ input: { id: 'other', text: 'Old tab.', expectedVersion: 0 } })).code, 'STALE_CONVERSATION');
  assert.equal(f.context.budget.remainingMicros, spent);
});

test('forbidden tools, extra authority and fake evidence arguments never reach host mutations', async () => {
  for (const item of [call('approve', { revisionId: 'forged' }),
    call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0, ownerId: 'other' }),
    call('offer_review', { summary: 'Approved!', evidenceId: 'forged' }),
    call('propose_scenarios', { revisionId: 'other', casesJson: '[]', expectedDraftVersion: 0 })]) {
    const f = fixture([item]);
    assert.equal((await f.run()).status, 'IDLE');
    assert.deepEqual(f.events, []);
    assert.deepEqual(JSON.parse(f.requests[1].toolResult.output), { ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
  }
});

test('old source ID after suite replacement is rejected; absent suite cannot simulate', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'revision1', casesJson: '[{"id":"case"}]', expectedDraftVersion: 1 }),
    call('simulate_draft', { revisionId: 'revision1', expectedDraftVersion: 1 })]);
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(f.events.filter(item => item[0] === 'simulate').length, 0);
  const absent = fixture([call('simulate_draft', { revisionId: 'compiled', expectedDraftVersion: 1 })], { revisionId: 'compiled', draftVersion: 1 });
  assert.equal((await absent.run()).status, 'IDLE'); assert.deepEqual(absent.events, []);
});

test('owner/run fence after provider await prevents a late mutation and retains spend', async () => {
  const f = fixture(); let release;
  f.provider.complete = request => { f.requests.push(request); return new Promise(resolve => { release = resolve; }); };
  const running = f.run(); await new Promise(resolve => setImmediate(resolve));
  f.context.current = () => false;
  release({ calls: [{ id: 'late', ...call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }) }], text: '',
    continuation: {}, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(await running, { status: 'BLOCKED', code: 'STALE_CONTEXT' });
  assert.deepEqual(f.events, []); assert.equal(f.context.budget.remainingMicros, 990);
});

test('external draft change during provider generation is not silently adopted', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  const original = f.provider.complete;
  f.provider.complete = async request => { const result = await original(request); f.setDraft({ revisionId: 'external', draftVersion: 1, suiteDigest: null }); return result; };
  assert.equal((await f.run()).code, 'STALE_DRAFT'); assert.deepEqual(f.events, []);
  const text = fixture(); const complete = text.provider.complete;
  text.provider.complete = async request => { const result = await complete(request); text.setDraft({ revisionId: 'external', draftVersion: 1, suiteDigest: null }); return result; };
  assert.deepEqual(await text.run(), { status: 'BLOCKED', code: 'STALE_DRAFT' });
  assert.equal(text.state.continuation, undefined, 'stale text and native continuation are not adopted');
});

test('unknown host failure is a safe blocker; duplicate IDs and false returned handles stop', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  f.host.compile = () => { throw new Error('SECRET raw compiler path'); };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
  const duplicate = fixture([call('discover_catalog', {}, 'same'), call('discover_catalog', {}, 'same')]);
  assert.equal((await duplicate.run()).code, 'PROVIDER_RESPONSE_INVALID'); assert.equal(duplicate.events.length, 1);
  const bad = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  bad.host.compile = () => ({ revisionId: 'forged', draftVersion: 0, suiteDigest: suite });
  assert.equal((await bad.run()).code, 'HOST_RESULT_INVALID');
});

test('every local cap stops before the next paid request or affected tool', async () => {
  for (const [limits, steps] of [
    [{ calls: 1 }, [call('discover_catalog')]], [{ tools: 0 }, [call('discover_catalog')]],
    [{ compiles: 0 }, [call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]],
    [{ clarifications: 0 }, [call('ask_clarification', { question: 'Question?' })]],
  ]) {
    const f = fixture(steps); assert.equal((await f.run({ limits })).code, 'BUDGET_EXHAUSTED');
    assert.equal(f.requests.length, 1);
    assert.equal(f.context.budget.remainingMicros, 990);
  }
  const f = fixture(); f.context.budget.remainingMicros = 9;
  assert.equal((await f.run()).code, 'SPEND_LIMIT'); assert.equal(f.requests.length, 0);
  const expired = fixture(); expired.state.createdAt -= 86400000;
  assert.equal((await expired.run()).code, 'EXPIRED'); assert.equal(expired.requests.length, 0);
  const badCap = fixture(); assert.equal((await badCap.run({ limits: { calls: 9 } })).code, 'CONFIG_INVALID');
});

test('concurrent runs share atomic budget and same conversation has no overlapping request', async () => {
  const first = fixture(); const second = fixture(); second.context.conversationId = second.state.conversationId = 'different';
  const budget = { remainingMicros: 10 }; first.context.budget = second.context.budget = budget;
  let release;
  first.provider.complete = () => new Promise(resolve => { release = resolve; });
  const running = first.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await first.run()).code, 'AI_BUSY');
  assert.equal((await second.run()).code, 'SPEND_LIMIT'); assert.equal(second.requests.length, 0);
  release({ calls: [], text: 'Stopped.', continuation: { provider: 'fake', items: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal((await running).status, 'IDLE'); assert.equal(budget.remainingMicros, 0);
});

test('cancel stops late provider results; interrupted persisted run never replays', async () => {
  const f = fixture(); const controller = new AbortController(); let release;
  f.provider.complete = () => new Promise(resolve => { release = resolve; });
  const running = f.run({ signal: controller.signal }); await new Promise(resolve => setImmediate(resolve));
  controller.abort(); assert.deepEqual(await running, { status: 'CANCELLED', code: 'CANCELLED' });
  release({ calls: [call('compile_draft')], text: '', continuation: {}, usage: { inputTokens: 1, outputTokens: 1 } });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.events, []); assert.equal(f.context.budget.remainingMicros, 990);
  const restarted = fixture(); restarted.state.status = 'RUNNING';
  assert.equal((await restarted.run()).code, 'RUN_INTERRUPTED'); assert.equal(restarted.requests.length, 0);
});

test('live context is revalidated after every kind of host await', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const [method, item] of [
    ['readDraft', call('discover_catalog')], ['discover', call('discover_catalog')],
    ['compile', call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 1 })],
    ['proposeScenarios', call('propose_scenarios', { revisionId: 'ready', casesJson: '[{}]', expectedDraftVersion: 1 })],
    ['simulate', call('simulate_draft', { revisionId: 'ready', expectedDraftVersion: 1 })],
    ['readEvidence', call('offer_review', { summary: 'Review.' })],
  ]) {
    const f = fixture([item], ready);
    f.host[method] = async () => { f.context.current = () => false; return { ...ready }; };
    const result = await f.run();
    assert.equal(result.code, 'STALE_CONTEXT', method); assert.equal(result.status, 'BLOCKED', method);
    assert.equal(f.state.handles?.revisionId ?? null, method === 'readDraft' ? null : 'ready');
  }
});

test('active deadline bounds a stuck host await and no subsequent work is dispatched', async () => {
  const f = fixture([call('discover_catalog')]);
  f.host.discover = () => new Promise(resolve => setTimeout(() => resolve({ catalog: [] }), 100));
  assert.equal((await f.run({ limits: { activeMs: 50 } })).code, 'TIME_LIMIT');
  assert.equal(f.requests.length, 1); assert.equal(f.context.budget.remainingMicros, 990);
});

test('source/case byte limits and malformed Unicode reject before host mutation', async () => {
  const items = [call('compile_draft', { sourceJson: 'x'.repeat(16385), expectedDraftVersion: 0 }),
    call('compile_draft', { sourceJson: '\ud800', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'compiled', casesJson: JSON.stringify(Array(9).fill({})), expectedDraftVersion: 1 }),
    call('propose_scenarios', { revisionId: 'compiled', casesJson: JSON.stringify([{ text: 'x'.repeat(49152) }]), expectedDraftVersion: 1 })];
  for (const item of items) {
    const f = fixture([item], { revisionId: 'compiled', draftVersion: item.arguments.expectedDraftVersion, suiteDigest: null });
    assert.equal((await f.run()).status, 'IDLE'); assert.deepEqual(f.events, []);
    assert.equal(JSON.parse(f.requests[1].toolResult.output).code, 'INVALID_TOOL_ARGUMENTS');
  }
});
