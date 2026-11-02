import test from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { AuthoringError, createAuthoringProvider } from '../src/authoring-provider.mjs';

const secret = 'provider-test-secret';
const config = provider => readAuthoringConfig({ KEIR_AI_PROVIDER: provider,
  KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
  KEIR_AI_MAX_USD: '1', OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret });
const tools = [{ name: 'lookup', description: 'Look up a record',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }];
const request = { input: 'Find a record', instructions: 'Use the tools', tools };
const openai = output => ({ status: 'completed', output,
  usage: { input_tokens: 20, output_tokens: 10 } });
const anthropic = (content, stop_reason = 'end_turn') => ({ content, stop_reason,
  usage: { input_tokens: 20, output_tokens: 10 } });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const errorCode = code => error => {
  assert.ok(error instanceof AuthoringError);
  assert.equal(error.code, code);
  assert.equal(String(error).includes(secret), false);
  return true;
};
const complete = (body, provider = 'openai', options = {}) =>
  createAuthoringProvider(config(provider), { fetchImpl: async () => json(body), ...options }).complete(request);

test('OpenAI uses native strict tools and preserves reasoning, call IDs and tool output', async () => {
  const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] };
  const call = { type: 'function_call', name: 'lookup', arguments: '{"id":"a"}', call_id: 'call-exact', id: 'fc1' };
  const sent = [];
  const provider = createAuthoringProvider(config('openai'), { fetchImpl: async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return json(sent.length === 1 ? openai([reasoning, call]) : openai([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found' }] }
    ]));
  } });
  assert.equal(provider.reserveMicros, config('openai').reserveMicros);
  assert.equal(provider.maxMicros, 1_000_000);
  const first = await provider.complete(request);
  assert.deepEqual(first.calls, [{ id: 'call-exact', name: 'lookup', arguments: { id: 'a' } }]);
  assert.deepEqual(first.usage, { inputTokens: 20, outputTokens: 10 });
  const last = await provider.complete({ ...request, input: undefined, continuation: first.continuation,
    toolResult: { id: 'call-exact', output: '{"found":true}' } });
  assert.equal(last.text, 'Found');
  assert.deepEqual(last.calls, []);
  const { url, init, body } = sent[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`);
  assert.equal(init.redirect, 'error');
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.tools[0].strict, true);
  assert.deepEqual(body.tools[0].parameters, tools[0].parameters);
  const next = sent[1].body.input;
  assert.ok(next.some(item => JSON.stringify(item) === JSON.stringify(reasoning)));
  const index = next.findIndex(item => item.call_id === 'call-exact' && item.type === 'function_call');
  assert.ok(index >= 0);
  assert.deepEqual(next[index + 1], { type: 'function_call_output', call_id: 'call-exact', output: '{"found":true}' });
});

test('Anthropic preserves thinking and places matching tool result before new input', async () => {
  const thinking = { type: 'thinking', thinking: 'opaque', signature: 'signature' };
  const redacted = { type: 'redacted_thinking', data: 'opaque-data' };
  const call = { type: 'tool_use', id: 'tool-exact', name: 'lookup', input: { id: 'a' } };
  const sent = [];
  const provider = createAuthoringProvider(config('anthropic'), { fetchImpl: async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return json(sent.length === 1 ? anthropic([thinking, redacted, call], 'tool_use') :
      anthropic([{ type: 'text', text: 'Done' }]));
  } });
  const first = await provider.complete(request);
  assert.deepEqual(first.calls, [{ id: 'tool-exact', name: 'lookup', arguments: { id: 'a' } }]);
  const last = await provider.complete({ ...request, input: 'Explain', continuation: first.continuation,
    toolResult: { id: 'tool-exact', output: 'record' } });
  assert.equal(last.text, 'Done');
  assert.deepEqual(last.calls, []);
  const { url, init, body } = sent[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(new Headers(init.headers).get('x-api-key'), secret);
  assert.equal(new Headers(init.headers).get('anthropic-version'), '2023-06-01');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.tools[0].strict, true);
  assert.deepEqual(body.tools[0].input_schema, tools[0].parameters);
  assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  const messages = sent[1].body.messages;
  const index = messages.findIndex(item => item.role === 'assistant');
  assert.deepEqual(messages[index].content, [thinking, redacted, call]);
  assert.equal(messages[index + 1].role, 'user');
  assert.deepEqual(messages[index + 1].content[0], { type: 'tool_result', tool_use_id: 'tool-exact', content: 'record' });
  assert.deepEqual(messages[index + 1].content[1], { type: 'text', text: 'Explain' });
});

test('rejects unsupported output, malformed calls, refusals and incomplete responses', async () => {
  const call = { type: 'function_call', name: 'lookup', arguments: '{}', call_id: 'c1' };
  const invalid = [openai([{ ...call, arguments: '{' }]), openai([{ ...call, arguments: '[]' }]),
    openai([{ ...call, call_id: '' }]), openai([{ ...call, call_id: 'id\n' }]), openai([call, { ...call, call_id: 'c2' }]),
    openai([{ type: 'unknown' }]), openai([{ type: 'message', role: 'developer', content: [{ type: 'output_text', text: 'Untrusted role' }] }]),
    openai([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }]),
    { ...openai([]), status: 'incomplete' }, { ...openai([]), usage: undefined },
    { ...openai([]), usage: { input_tokens: -1, output_tokens: 1 } }];
  for (const body of invalid) await assert.rejects(complete(body), errorCode('PROVIDER_RESPONSE_INVALID'));
  for (const body of [anthropic([], 'max_tokens'), anthropic([{ type: 'unknown' }]),
    anthropic([{ type: 'tool_use', id: 'a', name: 'lookup', input: {} }], 'end_turn'),
    anthropic([], 'tool_use'), anthropic([{ type: 'refusal', text: 'No' }])]) {
    await assert.rejects(complete(body, 'anthropic'), errorCode('PROVIDER_RESPONSE_INVALID'));
  }
});

test('requires bounded integer usage', async () => {
  for (const [input_tokens, output_tokens, code] of [[135169, 1, 'TOKEN_LIMIT'], [1, 4097, 'TOKEN_LIMIT'],
    [1.5, 1, 'PROVIDER_RESPONSE_INVALID'], [1, undefined, 'PROVIDER_RESPONSE_INVALID']]) {
    await assert.rejects(complete({ ...openai([]), usage: { input_tokens, output_tokens } }), errorCode(code));
  }
});

test('HTTP and network failures have fixed secret-safe errors without retries', async () => {
  for (const [status, code] of [[401, 'CREDENTIALS_INVALID'], [403, 'CREDENTIALS_INVALID'],
    [429, 'PROVIDER_RATE_LIMIT'], [302, 'PROVIDER_REDIRECT'], [500, 'PROVIDER_UNAVAILABLE']]) {
    let calls = 0;
    const provider = createAuthoringProvider(config('openai'), { fetchImpl: async () => {
      calls++;
      return new Response(secret, { status });
    } });
    await assert.rejects(provider.complete(request), errorCode(code));
    assert.equal(calls, 1);
  }
  const provider = createAuthoringProvider(config('openai'), { fetchImpl: async () => { throw Error(secret); } });
  await assert.rejects(provider.complete(request), errorCode('PROVIDER_UNAVAILABLE'));
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const rejected = createAuthoringProvider(config('openai'), { fetchImpl: async () => new Response(body, { status: 401 }) });
  await assert.rejects(rejected.complete(request), errorCode('CREDENTIALS_INVALID'));
  assert.equal(cancelled, true, 'unread HTTP failure bodies are cancelled');
});

test('caller abort and timeout abort fetch with distinct fixed errors', async () => {
  const waitingFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const provider = createAuthoringProvider(config('openai'), { fetchImpl: waitingFetch });
  const pending = provider.complete({ ...request, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, errorCode('CANCELLED'));
  await assert.rejects(createAuthoringProvider(config('openai'), { fetchImpl: waitingFetch, timeoutMs: 5 })
    .complete(request), errorCode('PROVIDER_TIMEOUT'));
});

test('bounds request and chunked response bytes and rejects non-JSON content', async () => {
  let fetched = false;
  const provider = createAuthoringProvider(config('openai'), { maxBytes: 1,
    fetchImpl: async () => { fetched = true; return json(openai([])); } });
  await assert.rejects(provider.complete(request), errorCode('BYTE_LIMIT'));
  assert.equal(fetched, false);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; } });
  await assert.rejects(createAuthoringProvider(config('openai'), { maxBytes: 2048,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) })
    .complete(request), errorCode('BYTE_LIMIT'));
  assert.equal(cancelled, true);
  await assert.rejects(createAuthoringProvider(config('openai'), {
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'text/html' } }) })
    .complete(request), errorCode('PROVIDER_RESPONSE_INVALID'));
});

test('rejects invalid setup and upward limit overrides', () => {
  assert.throws(() => createAuthoringProvider(readAuthoringConfig({})), errorCode('CONFIG_INVALID'));
  for (const options of [{ timeoutMs: 30001 }, { maxBytes: 131073 }, { maxOutputTokens: 4097 },
    { timeoutMs: 0 }, { maxBytes: -1 }, { maxOutputTokens: 1.5 }]) {
    assert.throws(() => createAuthoringProvider(config('openai'), options), errorCode('CONFIG_INVALID'));
  }
});

test('two global requests run and a third fails immediately without a queue', async () => {
  const releases = [];
  const fetchImpl = async () => new Promise(resolve => releases.push(() => resolve(json(openai([])))));
  const first = createAuthoringProvider(config('openai'), { fetchImpl });
  const second = createAuthoringProvider(config('anthropic'), { fetchImpl });
  const pending = [first.complete(request), first.complete(request)];
  try {
    await assert.rejects(second.complete(request), errorCode('AI_BUSY'));
  } finally {
    releases.forEach(release => release());
    await Promise.all(pending);
  }
});
