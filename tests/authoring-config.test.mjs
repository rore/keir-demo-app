import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readAuthoringConfig } from '../src/authoring-config.mjs';

const valid = (provider, model, cap, keyName, key = 'secret-value') => ({
  KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: model, KEIR_AI_MAX_USD: cap, [keyName]: key
});

test('accepts supported tariffs with exact microdollar caps and hidden credentials', () => {
  const original = process.env.KEIR_AI_PROVIDER;
  const cases = [
    [valid('openai', 'gpt-5.6-terra', '1.234567', 'OPENAI_API_KEY'), 1_234_567, 319488],
    [valid('anthropic', 'claude-haiku-5-5', '0.01', 'ANTHROPIC_API_KEY'), 10_000, 77_824]
  ];
  for (const [env, maxMicros, reserveMicros] of cases) {
    const config = readAuthoringConfig(env);
    assert.deepEqual({ ...config }, { status: 'ready', provider: env.KEIR_AI_PROVIDER,
      model: env.KEIR_AI_MODEL, maxMicros, reserveMicros });
    assert.equal(config.apiKey, 'secret-value');
    assert.equal(Object.isFrozen(config), true);
    assert.equal(JSON.stringify(config).includes('secret-value'), false);
    assert.equal(inspect(config).includes('secret-value'), false);
  }
  assert.equal(process.env.KEIR_AI_PROVIDER, original);
});

test('Haiku reservation covers reachable input tariff tiers', () => {
  const config = readAuthoringConfig(valid('anthropic', 'claude-haiku-5-5', '0.08', 'ANTHROPIC_API_KEY'));
  for (const [inputTokens, expectedMicros] of [[100_000, 12_048], [100_001, 60_241], [135_168, 77_824]]) {
    const [inputRate, outputRate] = inputTokens <= 100_000 ? [0.10, 0.50] : [0.50, 2.50];
    const requiredMicros = Math.ceil(inputTokens * inputRate + 4096 * outputRate);
    assert.equal(requiredMicros, expectedMicros);
    assert.equal(config.reserveMicros >= requiredMicros, true, `${inputTokens} input tokens`);
  }
});

test('missing provider does not read credential getters', () => {
  const env = { get OPENAI_API_KEY() { throw Error('read key'); } };
  assert.deepEqual(readAuthoringConfig(env), { status: 'unavailable', code: 'AI_NOT_CONFIGURED' });
});

test('rejects unsupported and malformed configuration with fixed results', () => {
  const base = valid('openai', 'gpt-5.6-terra', '1', 'OPENAI_API_KEY');
  for (const cap of ['0', '-1', '1e2', 'NaN', '1.1234567', '9007199255.000000', '1\n']) {
    assert.equal(readAuthoringConfig({ ...base, KEIR_AI_MAX_USD: cap }).code, 'AI_CONFIG_INVALID');
  }
  assert.equal(readAuthoringConfig({ ...base, KEIR_AI_PROVIDER: 'other' }).code, 'AI_CONFIG_INVALID');
  assert.equal(readAuthoringConfig({ ...base, KEIR_AI_PROVIDER: '__proto__', KEIR_AI_MODEL: undefined }).code, 'AI_CONFIG_INVALID');
  assert.equal(readAuthoringConfig({ ...base, KEIR_AI_MODEL: 'other' }).code, 'AI_CONFIG_INVALID');
  for (const key of ['', ' ', 'bad key', 'bad\nkey', 'x'.repeat(4097)]) {
    const result = readAuthoringConfig({ ...base, OPENAI_API_KEY: key });
    assert.deepEqual(result, { status: 'unavailable', code: 'AI_CREDENTIALS_MISSING' });
    assert.equal(JSON.stringify(result).includes('bad\nkey'), false);
  }
});
