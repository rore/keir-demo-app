// Native wire adapters only: all tool authority stays in the host loop.
export class AuthoringError extends Error {
  constructor(code) { super(code); this.name = 'AuthoringError'; this.code = code; }
}
const fail = code => { throw new AuthoringError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const id = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
let activeRequests = 0;

export function abortable(promise, signal, code = 'CANCELLED') {
  if (signal.aborted) return Promise.reject(new AuthoringError(code));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AuthoringError(code));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createAuthoringProvider(config, { fetchImpl = globalThis.fetch, timeoutMs = 30000, maxBytes = 131072, maxOutputTokens = 4096 } = {}) {
  if (config?.status !== 'ready' || !['openai', 'anthropic'].includes(config.provider)
      || config.model !== (config.provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5')
      || typeof config.apiKey !== 'string' || !config.apiKey || typeof fetchImpl !== 'function'
      || ![timeoutMs, maxBytes, maxOutputTokens].every(value => Number.isSafeInteger(value) && value > 0)
      || timeoutMs > 30000 || maxBytes > 131072 || maxOutputTokens > 4096
      || !integer(config.maxMicros) || !integer(config.reserveMicros) || !config.reserveMicros) fail('CONFIG_INVALID');
  const provider = config.provider;
  function prepare(request) {
    try {
      const { input, continuation, toolResult, tools, instructions, signal } = request;
      if (signal?.aborted) fail('CANCELLED');
      if (typeof instructions !== 'string' || !Array.isArray(tools)
          || input !== undefined && typeof input !== 'string'
          || continuation !== undefined && (!object(continuation) || continuation.provider !== provider || !Array.isArray(continuation.items))
          || toolResult !== undefined && (!object(toolResult) || !id(toolResult.id) || typeof toolResult.output !== 'string')) fail('CONFIG_INVALID');
      const items = structuredClone(continuation?.items ?? []);
      const headers = { 'content-type': 'application/json' };
      let url, body;
      if (provider === 'openai') {
        url = 'https://api.openai.com/v1/responses';
        headers.authorization = `Bearer ${config.apiKey}`;
        if (toolResult) items.push({ type: 'function_call_output', call_id: toolResult.id, output: toolResult.output });
        if (input !== undefined) items.push({ role: 'user', content: input });
        body = { model: config.model, instructions, input: items, store: false,
          reasoning: { effort: 'low' }, max_output_tokens: maxOutputTokens, parallel_tool_calls: false,
          tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })) };
      } else {
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        const content = [];
        if (toolResult) content.push({ type: 'tool_result', tool_use_id: toolResult.id, content: toolResult.output });
        if (input !== undefined) content.push({ type: 'text', text: input });
        if (content.length) items.push({ role: 'user', content });
        body = { model: config.model, system: instructions, messages: items, max_tokens: maxOutputTokens,
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, strict: true })) };
      }
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > maxBytes) fail('CONTEXT_LIMIT');
      return { url, headers, encoded, items };
    } catch (error) {
      if (error instanceof AuthoringError) throw error;
      fail('CONFIG_INVALID');
    }
  }
  return Object.freeze({
    provider, model: config.model, maxMicros: config.maxMicros, reserveMicros: config.reserveMicros,
    preflight(request) { prepare(request); },
    async complete(request) {
      const { url, headers, encoded, items } = prepare(request), { signal } = request;
      if (activeRequests >= 2) fail('AI_BUSY');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const abortCode = () => signal?.aborted ? 'CANCELLED' : 'PROVIDER_TIMEOUT';
      const wait = promise => abortable(promise, combined).catch(error => {
        if (combined.aborted) fail(abortCode());
        throw error;
      });
      let reader, response, fetching, reading;
      activeRequests++;
      try {
        try { response = await wait(fetching = Promise.resolve(fetchImpl(url, { method: 'POST', headers, body: encoded, redirect: 'error', signal: combined }))); }
        catch (error) { if (error instanceof AuthoringError) throw error; fail('PROVIDER_UNAVAILABLE'); }
        if ([401, 403].includes(response.status)) fail('CREDENTIALS_INVALID');
        if (response.status === 429) fail('PROVIDER_RATE_LIMIT');
        if (response.status >= 300 && response.status < 400) fail('PROVIDER_REDIRECT');
        if (response.status !== 200) fail('PROVIDER_UNAVAILABLE');
        if (response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('PROVIDER_RESPONSE_INVALID');
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) > maxBytes) fail('BYTE_LIMIT');
        reader = response.body?.getReader();
        if (!reader) fail('PROVIDER_RESPONSE_INVALID');
        const chunks = []; let size = 0;
        for (;;) {
          const { done, value } = await wait(reading = Promise.resolve(reader.read()));
          if (done) break;
          if (!(value instanceof Uint8Array)) fail('PROVIDER_RESPONSE_INVALID');
          size += value.byteLength;
          if (size > maxBytes) fail('BYTE_LIMIT');
          chunks.push(value);
        }
        let raw;
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { fail('PROVIDER_RESPONSE_INVALID'); }
        const calls = [], text = [];
        let native;
        if (provider === 'openai') {
          if (raw?.status !== 'completed' || !Array.isArray(raw.output)) fail('PROVIDER_RESPONSE_INVALID');
          native = raw.output;
          for (const item of native) {
            if (item?.type === 'function_call') {
              let args;
              try { args = JSON.parse(item.arguments); } catch { fail('PROVIDER_RESPONSE_INVALID'); }
              calls.push({ id: item.call_id, name: item.name, arguments: args });
            } else if (item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part?.type !== 'output_text' || typeof part.text !== 'string') fail('PROVIDER_RESPONSE_INVALID');
                text.push(part.text);
              }
            } else if (item?.type !== 'reasoning') fail('PROVIDER_RESPONSE_INVALID');
          }
          items.push(...native);
        } else {
          if (!['tool_use', 'end_turn'].includes(raw?.stop_reason) || !Array.isArray(raw.content)) fail('PROVIDER_RESPONSE_INVALID');
          native = raw.content;
          for (const item of native) {
            if (item?.type === 'tool_use') calls.push({ id: item.id, name: item.name, arguments: item.input });
            else if (item?.type === 'text' && typeof item.text === 'string') text.push(item.text);
            else if (!['thinking', 'redacted_thinking'].includes(item?.type)) fail('PROVIDER_RESPONSE_INVALID');
          }
          if ((raw.stop_reason === 'tool_use') !== (calls.length > 0)) fail('PROVIDER_RESPONSE_INVALID');
          items.push({ role: 'assistant', content: native });
        }
        if (calls.length > 1 || calls.some(call => !id(call.id) || !id(call.name) || !object(call.arguments))) fail('PROVIDER_RESPONSE_INVALID');
        const usage = raw.usage;
        if (!object(usage) || !integer(usage.input_tokens) || !integer(usage.output_tokens)) fail('PROVIDER_RESPONSE_INVALID');
        let inputTokens = usage.input_tokens;
        for (const key of provider === 'anthropic' ? ['cache_read_input_tokens', 'cache_creation_input_tokens'] : []) {
          if (usage[key] !== undefined) { if (!integer(usage[key])) fail('PROVIDER_RESPONSE_INVALID'); inputTokens += usage[key]; }
        }
        if (!Number.isSafeInteger(inputTokens) || inputTokens > 135168 || usage.output_tokens > maxOutputTokens) fail('TOKEN_LIMIT');
        const result = { continuation: { provider, items }, calls, text: text.join('\n'), usage: { inputTokens, outputTokens: usage.output_tokens } };
        if (bytes(result) > 262144) fail('BYTE_LIMIT');
        return result;
      } catch (error) {
        if (combined.aborted) fail(abortCode());
        if (error instanceof AuthoringError) throw error;
        fail('PROVIDER_RESPONSE_INVALID');
      } finally {
        // Retain the slot until aborted transport and late response cleanup actually settle.
        if (!response && fetching) { try { response = await fetching; } catch { /* Fetch closed without a response. */ } }
        try {
          if (reader) await reader.cancel();
          else if (response?.body) await response.body.cancel();
        } catch { /* Cancellation failure is still settled. */ }
        if (reading) { try { await reading; } catch { /* The reader closed with an error. */ } }
        activeRequests--;
      }
    },
  });
}
