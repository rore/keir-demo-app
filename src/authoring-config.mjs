const tariffs = {
  // 30-minute cache writes cost 1.25x ordinary input; reserve the highest reachable rate.
  openai: { model: 'gpt-5.6-terra', input: 2.50, output: 12, key: 'OPENAI_API_KEY' },
  anthropic: { model: 'claude-haiku-5-5', input: 0.50, output: 2.50, key: 'ANTHROPIC_API_KEY' }
};

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
