const tariffs = {
  // 30-minute cache writes cost 1.25x ordinary input; reserve the highest reachable rate.
  openai: { model: 'gpt-5.6-terra', input: 2.50, output: 12, key: 'OPENAI_API_KEY' },
  anthropic: { model: 'claude-haiku-5-5', input: 0.50, output: 2.50, key: 'ANTHROPIC_API_KEY' }
};

// Integer hundredths of a microdollar per token. Unknown OpenAI input may be
// a 30-minute cache write; missing cache detail never earns a read discount.
export function estimateAuthoringMicros(provider, usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (!valid(usage.input_tokens) || !valid(usage.output_tokens)) return null;
  const input = usage.input_tokens, output = usage.output_tokens;
  if (provider === 'openai') {
    const details = usage.input_tokens_details;
    if (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details))) return null;
    const read = Object.hasOwn(details ?? {}, 'cached_tokens') ? details.cached_tokens : 0;
    const write = Object.hasOwn(details ?? {}, 'cache_write_tokens') ? details.cache_write_tokens : undefined;
    if (!valid(read) || read > input || write !== undefined && (!valid(write) || write > input - read)) return null;
    const weighted = write === undefined ? (input - read) * 250 : (input - read - write) * 200 + write * 250;
    return Math.ceil((weighted + read * 20 + output * 1200) / 100);
  }
  if (provider !== 'anthropic') return null;
  const read = Object.hasOwn(usage, 'cache_read_input_tokens') ? usage.cache_read_input_tokens : 0;
  const write = Object.hasOwn(usage, 'cache_creation_input_tokens') ? usage.cache_creation_input_tokens : 0;
  if (!valid(read) || !valid(write)) return null;
  const detail = usage.cache_creation;
  let long = write;
  if (detail !== undefined) {
    if (!detail || !valid(detail.ephemeral_5m_input_tokens) || !valid(detail.ephemeral_1h_input_tokens)
        || detail.ephemeral_5m_input_tokens + detail.ephemeral_1h_input_tokens !== write) return null;
    long = detail.ephemeral_1h_input_tokens;
  }
  const shortPrompt = input + read + write <= 100_000;
  return Math.ceil((input * 100 + read * 10 + (write - long) * 125 + long * 200 + output * 500) / (shortPrompt ? 1000 : 200));
}

const unavailable = code => Object.freeze({ status: 'unavailable', code });

export const LEGACY_OPENAI_RESERVE_MICROS = 319488;
export const OPENAI_RESERVE_MICROS = Math.ceil(135168 * tariffs.openai.input + 4096 * tariffs.openai.output);

export const authoringChoices = Object.freeze(Object.entries(tariffs).map(([provider, { model }]) => Object.freeze({ provider, model })));

export function readSetupConfig(input, settingsRevision) {
  const fields = ['provider', 'model', 'apiKey', 'maxUsd'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
      || fields.some(field => !Object.hasOwn(input, field) || typeof input[field] !== 'string')
      || !Object.hasOwn(tariffs, input.provider)) return unavailable('AI_CONFIG_INVALID');
  const key = tariffs[input.provider].key;
  return readAuthoringConfig({ KEIR_AI_PROVIDER: input.provider, KEIR_AI_MODEL: input.model, KEIR_AI_MAX_USD: input.maxUsd,
    [key]: input.apiKey }, settingsRevision);
}

export function readAuthoringConfig(env = process.env, settingsRevision) {
  const provider = env.KEIR_AI_PROVIDER;
  if (provider === undefined || provider === '') return unavailable('AI_NOT_CONFIGURED');
  if (!Object.hasOwn(tariffs, provider)) return unavailable('AI_CONFIG_INVALID');
  const tariff = tariffs[provider];
  if (env.KEIR_AI_MODEL !== tariff.model) return unavailable('AI_CONFIG_INVALID');
  const cap = env.KEIR_AI_MAX_USD;
  const uncapped = cap === undefined || cap === '';
  // With no spending cap, the durable ledger still has its safe-integer bound.
  let maxMicros = Number.MAX_SAFE_INTEGER;
  if (!uncapped) {
    if (typeof cap !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(cap) || cap !== cap.trim()) return unavailable('AI_CONFIG_INVALID');
    const [whole, fraction = ''] = cap.split('.');
    maxMicros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
    if (!Number.isSafeInteger(maxMicros) || maxMicros <= 0) return unavailable('AI_CONFIG_INVALID');
  }
  const apiKey = env[tariff.key];
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) {
    return unavailable('AI_CREDENTIALS_MISSING');
  }
  const result = { status: 'ready', provider, model: tariff.model, maxMicros, ...(uncapped && { uncapped }),
    reserveMicros: Math.ceil(135168 * tariff.input + 4096 * tariff.output) };
  Object.defineProperty(result, 'apiKey', { value: apiKey, enumerable: false });
  if (settingsRevision !== undefined) Object.defineProperty(result, 'settingsRevision', { value: settingsRevision, enumerable: false });
  return Object.freeze(result);
}
