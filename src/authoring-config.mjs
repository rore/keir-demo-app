const tariffs = {
  openai: { model: 'gpt-5.6-terra', input: 2, output: 12, key: 'OPENAI_API_KEY' },
  anthropic: { model: 'claude-haiku-5-5', input: 0.50, output: 2.50, key: 'ANTHROPIC_API_KEY' }
};

const unavailable = code => Object.freeze({ status: 'unavailable', code });

export function readAuthoringConfig(env = process.env) {
  const provider = env.KEIR_AI_PROVIDER;
  if (provider === undefined || provider === '') return unavailable('AI_NOT_CONFIGURED');
  if (!Object.hasOwn(tariffs, provider)) return unavailable('AI_CONFIG_INVALID');
  const tariff = tariffs[provider];
  if (env.KEIR_AI_MODEL !== tariff.model) return unavailable('AI_CONFIG_INVALID');
  const cap = env.KEIR_AI_MAX_USD;
  if (typeof cap !== 'string' || cap !== cap.trim() || !/^\d+(?:\.\d{1,6})?$/.test(cap)) return unavailable('AI_CONFIG_INVALID');
  const [whole, fraction = ''] = cap.split('.');
  const maxMicros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(maxMicros) || maxMicros <= 0) return unavailable('AI_CONFIG_INVALID');
  const apiKey = env[tariff.key];
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) {
    return unavailable('AI_CREDENTIALS_MISSING');
  }
  const result = { status: 'ready', provider, model: tariff.model, maxMicros,
    reserveMicros: Math.ceil(135168 * tariff.input + 4096 * tariff.output) };
  Object.defineProperty(result, 'apiKey', { value: apiKey, enumerable: false });
  return Object.freeze(result);
}
