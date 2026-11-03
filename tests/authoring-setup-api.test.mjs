import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';

const origin = 'http://127.0.0.1:32123';
const sentinel = 'fake-setup-key-must-never-leak';
const setup = (apiKey = sentinel, overrides = {}) => ({ provider: 'openai', model: 'gpt-5.6-terra', apiKey, maxUsd: '3', ...overrides });
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
const assertPrivate = (value, file) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(sentinel), false);
  assert.equal(text.includes(file), false);
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'keir-setup-api-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  return { directory, file: join(directory, 'ai-authoring.json') };
}
function cleanup(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
async function appFor(t, file, authoring = {}) {
  const db = openData(':memory:');
  const app = await createApp({ db, origin, compiler: { compile: async () => ({ artifact: Buffer.from('{}'), diagnostics: [] }) },
    authoringSettingsFile: file, authoring });
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/authoring/setup' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  const login = async () => {
    const bootstrap = (await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:32123', ...auth } })).json();
    const response = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, 'x-session-context': bootstrap.contextToken }, payload: { userId: 'maya' } });
    assert.equal(response.statusCode, 200);
    auth = { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
  };
  return { app, call, login, getAuth: () => ({ ...auth }) };
}
function assertSafeSetup(value) {
  keys(value, ['configuration', 'choices', 'availability']);
  keys(value.configuration, ['status', 'code', 'source', 'provider', 'model', 'maxUsd']);
  keys(value.availability, ['available', 'code', 'provider', 'model']);
  assert.deepEqual(value.choices, [
    { provider: 'openai', model: 'gpt-5.6-terra' },
    { provider: 'anthropic', model: 'claude-haiku-5-5' }
  ]);
  assert.equal(JSON.stringify(value).includes(sentinel), false);
}

test('setup API is owner authenticated, exact-origin, query-free and returns only safe configuration status', async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const { call, login, getAuth } = await appFor(t, file);
  assert.equal((await call('')).statusCode, 401);
  assert.equal((await call('', undefined, { 'x-session-context': 'anonymous-session-token' })).statusCode, 401);
  await login();
  assert.equal((await call('?owner=maya')).statusCode, 400);
  assert.equal((await call('', undefined, { host: 'localhost:32123' })).statusCode, 403);
  assert.equal((await call('', undefined, { origin: 'http://foreign.invalid' })).statusCode, 403);
  const auth = getAuth();
  const value = await call('');
  assert.equal(value.statusCode, 200);
  assertSafeSetup(value.json());
  await login();
  assert.equal((await call('', undefined, auth)).statusCode, 401);
});

test('encoded setup aliases retain route authentication, origin, content-type and privacy guards', async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const { app, login, getAuth } = await appFor(t, file); await login();
  const aliases = ['/%61pi/authoring/setup', '/api/authoring/%73etup'];
  const send = (url, { method = 'GET', payload, auth = getAuth(), originHeader = origin, contentType = 'application/json' } = {}) => {
    const headers = { host: '127.0.0.1:32123', 'content-type': contentType, ...auth };
    if (originHeader !== null) headers.origin = originHeader;
    return app.inject({ url, method, headers, ...(payload === undefined ? {} : { payload }) });
  };
  const initial = (await send(aliases[0])).json();
  assertSafeSetup(initial);
  for (const alias of aliases) {
    const noOrigin = await send(alias, { method: 'POST', payload: JSON.stringify(setup()), originHeader: null });
    assert.equal(noOrigin.statusCode, 403);
    const foreignOrigin = await send(alias, { method: 'POST', payload: JSON.stringify(setup()), originHeader: 'http://foreign.invalid' });
    assert.equal(foreignOrigin.statusCode, 403);
    const wrongType = await send(alias, { method: 'POST', payload: JSON.stringify(setup()), contentType: 'text/plain' });
    assert.equal(wrongType.statusCode, 415);
    const unauthorized = await send(alias, { method: 'POST', payload: JSON.stringify(setup()), auth: {} });
    assert.equal(unauthorized.statusCode, 401);
    const get = await send(alias);
    assert.equal(get.statusCode, 200); assert.equal(get.headers['cache-control'], 'no-store');
    assert.deepEqual(get.json(), initial);
    const malformed = await send(alias, { method: 'POST', payload: '{"apiKey":"' + sentinel + '",' });
    assert.equal(malformed.statusCode, 400); assertPrivate(malformed.body, file);
    assert.equal(existsSync(file), false);
  }
  for (const alias of aliases) {
    const accepted = await send(alias, { method: 'POST', payload: JSON.stringify(setup()) });
    assert.equal(accepted.statusCode, 200); assertSafeSetup(accepted.json());
  }
  assert.ok(existsSync(file));
});

test('valid setup saves without provider traffic, applies immediately, survives reopen and dispatches with the new key', async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const seenKeys = [];
  const providerFactory = config => {
    seenKeys.push(config.apiKey);
    return { reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
      async complete() { return { calls: [], text: 'Saved locally.', usage: { inputTokens: 1, outputTokens: 1 } }; } };
  };
  const first = await appFor(t, file, { providerFactory }); await first.login();
  const saved = await first.call('', setup());
  assert.equal(saved.statusCode, 200); assertSafeSetup(saved.json());
  assert.deepEqual(saved.json().configuration, { status: 'ready', code: null, source: 'local', provider: 'openai', model: 'gpt-5.6-terra', maxUsd: '3' });
  assert.equal(seenKeys.length, 0, 'saving settings must not call a provider');
  assert.ok(existsSync(file)); assert.ok(readFileSync(file, 'utf8').includes(sentinel));
  assertPrivate((await first.app.inject({ url: '/api/authoring', headers: { host: '127.0.0.1:32123', ...first.getAuth() } })).body, file);
  assertPrivate((await first.app.inject({ url: '/', headers: { host: '127.0.0.1:32123' } })).body, file);
  assertPrivate(saved.json(), file);
  const turn = await first.app.inject({ method: 'POST', url: '/api/authoring/turn', headers: {
    host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...first.getAuth()
  }, payload: { target: { kind: 'create' }, conversationId: null, operationId: 'setup-dispatch', text: 'Help with task advice.', expectedVersion: 0, expectedDraftVersion: 0 } });
  assert.equal(turn.statusCode, 202);
  assert.deepEqual(seenKeys, [sentinel]);

  const reopened = await appFor(t, file); await reopened.login();
  const status = await reopened.call('');
  assert.equal(status.statusCode, 200); assertSafeSetup(status.json());
  assert.deepEqual(status.json().configuration, saved.json().configuration);
});

test('invalid, malformed and oversized saves have fixed errors and never disclose submitted keys', async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const { call, login } = await appFor(t, file); await login();
  const invalid = await call('', setup(sentinel, { model: 'wrong-model' }));
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().code, 'AI_CONFIG_INVALID');
  assertPrivate(invalid.json(), file); assert.equal(existsSync(file), false);
  const emptyProvider = await call('', setup(sentinel, { provider: '' }));
  assert.equal(emptyProvider.statusCode, 400); assert.equal(emptyProvider.json().code, 'AI_CONFIG_INVALID');
  assertPrivate(emptyProvider.json(), file); assert.equal(existsSync(file), false);
  const extra = await call('', { ...setup(), endpoint: 'https://attacker.invalid' });
  assert.equal(extra.statusCode, 400); assertPrivate(extra.json(), file); assert.equal(existsSync(file), false);
  const missing = await call('', { provider: 'openai', model: 'gpt-5.6-terra', maxUsd: '3' });
  assert.equal(missing.statusCode, 400); assertPrivate(missing.json(), file);
  const noCredential = await call('', setup(''));
  assert.equal(noCredential.statusCode, 400); assert.equal(noCredential.json().code, 'AI_CREDENTIALS_MISSING');
  assertPrivate(noCredential.json(), file);
  const parser = await call('', '{"apiKey":"' + sentinel + '",');
  assert.ok(parser.statusCode >= 400); assertPrivate(parser.json(), file);
  const oversized = await call('', setup('x'.repeat(8193)));
  assert.equal(oversized.statusCode, 413); assertPrivate(oversized.json(), file);
  assert.equal(JSON.stringify(oversized.json()).includes('x'.repeat(128)), false);
  assert.equal(existsSync(file), false);
});

test('failed replacement preserves old bytes and a supplied missing parent causes no filesystem writes', async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const { call, login } = await appFor(t, file); await login();
  assert.equal((await call('', setup())).statusCode, 200);
  const old = readFileSync(file);
  const backup = file + '.held'; renameSync(file, backup); mkdirSync(file);
  const failed = await call('', setup('second-fake-key'));
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'AI_CONFIG_SAVE_FAILED');
  assert.deepEqual(readFileSync(backup), old);
  assert.equal(readdirSync(directory).some(name => name.startsWith('.ai-authoring-') || name.endsWith('.tmp')), false);
  rmSync(file, { recursive: true }); renameSync(backup, file);

  const missingParent = join(directory, 'absent', 'ai-authoring.json');
  const noParent = await appFor(t, missingParent); await noParent.login();
  const rejected = await noParent.call('', setup('third-fake-key'));
  assert.equal(rejected.statusCode, 503); assert.equal(rejected.json().code, 'AI_CONFIG_SAVE_FAILED');
  assert.equal(existsSync(join(directory, 'absent')), false);

  const beforeNoPath = readdirSync(directory).sort();
  const noPath = await appFor(t, undefined); await noPath.login();
  const invalidWithoutPath = await noPath.call('', setup('', { model: 'wrong-model' }));
  assert.equal(invalidWithoutPath.statusCode, 400);
  const unavailable = await noPath.call('', setup('fourth-fake-key'));
  assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().code, 'AI_CONFIG_SAVE_FAILED');
  assert.deepEqual(readdirSync(directory).sort(), beforeNoPath);
});

test('a real partially delivered setup body is rejected after its session is revoked', { timeout: 5000 }, async t => {
  const { directory, file } = fixture(); t.after(() => cleanup(directory));
  const { app, login, getAuth } = await appFor(t, file); await login();
  const headers = getAuth();
  const body = JSON.stringify(setup());
  await app.listen({ host: '127.0.0.1', port: 0 });
  let pending;
  try {
    let bodyStarted;
    const started = new Promise(resolve => { bodyStarted = resolve; });
    app.server.prependOnceListener('request', bodyStarted);
    const response = new Promise((resolve, reject) => {
      pending = request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/authoring/setup', method: 'POST',
        headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      pending.on('error', reject); pending.setTimeout(3000, () => pending.destroy(new Error('Test request timed out.'))); pending.write(body.slice(0, 1));
    });
    await Promise.race([started, response]);
    const current = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...headers }, payload: { userId: 'leo' } });
    assert.equal(current.statusCode, 200);
    pending.end(body.slice(1));
    assert.equal(await response, 401);
    assert.equal(existsSync(file), false);
  } finally { pending?.destroy(); app.server.closeAllConnections(); }
});
