import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthoringSettings, assertAuthoringSettingsLocation } from '../src/authoring-settings.mjs';

const setup = (apiKey = 'synthetic-test-key', overrides = {}) => ({ provider: 'openai', model: 'gpt-5.6-terra', apiKey, maxUsd: '3', ...overrides });
const environment = (apiKey = 'environment-test-key') => ({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '2.25', OPENAI_API_KEY: apiKey });

function tempDir(t) {
  const root = tmpdir();
  const directory = mkdtempSync(join(root, 'keir-authoring-settings-test-'));
  t.after(() => {
    const path = relative(resolve(root), resolve(directory));
    assert.ok(path && path !== '..' && !path.startsWith('..' + sep), 'cleanup stays inside the test temporary root');
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function save(settings, input = setup()) {
  const prepared = settings.prepare(input);
  prepared.persist();
  return prepared.config;
}

test('missing files use only complete environment configuration and valid local settings take precedence', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  const absent = createAuthoringSettings({ file, env: {} });
  assert.equal(absent.config.code, 'AI_NOT_CONFIGURED');
  assert.equal(absent.publicConfiguration().source, 'none');

  const envOnly = createAuthoringSettings({ file, env: environment() });
  assert.equal(envOnly.config.status, 'ready');
  assert.equal(envOnly.config.apiKey, 'environment-test-key');
  assert.deepEqual(envOnly.publicConfiguration(), { status: 'ready', code: null, source: 'environment',
    provider: 'openai', model: 'gpt-5.6-terra', maxUsd: '2.25' });
  const partial = createAuthoringSettings({ file: join(directory, 'partial.json'), env: { KEIR_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'ignored' } });
  assert.equal(partial.config.code, 'AI_CONFIG_INVALID');

  const writer = createAuthoringSettings({ file, env: {} });
  save(writer, setup('local-test-key', { maxUsd: '4.5' }));
  const reopened = createAuthoringSettings({ file, env: environment() });
  assert.equal(reopened.config.apiKey, 'local-test-key');
  assert.deepEqual(reopened.publicConfiguration(), { status: 'ready', code: null, source: 'local',
    provider: 'openai', model: 'gpt-5.6-terra', maxUsd: '4.5' });
});

test('invalid local settings fail closed instead of falling back to environment credentials', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  writeFileSync(file, '{"version":99}');
  const settings = createAuthoringSettings({ file, env: environment() });
  assert.deepEqual(settings.config, { status: 'unavailable', code: 'AI_CONFIG_INVALID' });
  assert.deepEqual(settings.publicConfiguration(), { status: 'unavailable', code: 'AI_CONFIG_INVALID', source: 'local',
    provider: null, model: null, maxUsd: null });
});

test('stored settings require the exact versioned shape and stay within the read ceiling', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  const settings = createAuthoringSettings({ file, env: {} });
  const bytes = Buffer.from(JSON.stringify({ version: 1, revision: '12345678-1234-1234-1234-123456789abc', ...setup('stored-key') }));
  for (const saved of [
    { version: 2, revision: '12345678-1234-1234-1234-123456789abc', ...setup('stored-key') },
    { version: 1, revision: 'bad-revision', ...setup('stored-key') },
    { version: 1, revision: '12345678-1234-1234-1234-123456789abc', ...setup('stored-key'), extra: true }
  ]) {
    writeFileSync(file, JSON.stringify(saved));
    assert.equal(createAuthoringSettings({ file, env: environment() }).config.code, 'AI_CONFIG_INVALID');
  }
  writeFileSync(file, Buffer.concat([bytes, Buffer.alloc(8192 - bytes.length, 0x20)]));
  assert.equal(createAuthoringSettings({ file, env: {} }).config.status, 'ready', 'exactly 8192 bytes remains readable');
  writeFileSync(file, Buffer.concat([bytes, Buffer.alloc(8193 - bytes.length, 0x20)]));
  assert.equal(createAuthoringSettings({ file, env: environment() }).config.code, 'AI_CONFIG_INVALID');

  const nonregular = join(directory, 'nonregular', 'ai-authoring.json');
  mkdirSync(nonregular, { recursive: true });
  assert.equal(createAuthoringSettings({ file: nonregular, env: environment() }).config.code, 'AI_CONFIG_INVALID');

});

test('settings loader rejects symlink files', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json'), target = join(directory, 'target.json');
  writeFileSync(target, JSON.stringify({ version: 1, revision: '12345678-1234-1234-1234-123456789abc', ...setup('stored-key') }));
  try { symlinkSync(target, file); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('this Windows account cannot create symlinks');
    throw error;
  }
  assert.equal(createAuthoringSettings({ file, env: environment() }).config.code, 'AI_CONFIG_INVALID');
});

test('public allowance is exact decimal micro-USD and credentials stay hidden from inspection and JSON', () => {
  const maxSafeMicros = '9007199254740991';
  const settings = createAuthoringSettings({ env: { KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
    KEIR_AI_MAX_USD: '9007199254.740991', OPENAI_API_KEY: 'inspection-sentinel' } });
  assert.equal(settings.publicConfiguration().maxUsd, '9007199254.740991');
  assert.equal(BigInt(settings.config.maxMicros).toString(), maxSafeMicros);
  assert.equal(JSON.stringify(settings.config).includes('inspection-sentinel'), false);
  assert.equal(inspect(settings.config).includes('inspection-sentinel'), false);
  assert.equal(JSON.stringify(settings.publicConfiguration()).includes('inspection-sentinel'), false);
});

test('prepare validates before persistence and failed saves preserve the current snapshot and old bytes', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  const settings = createAuthoringSettings({ file, config: createAuthoringSettings({ env: environment() }).config });
  const first = save(settings, setup('old-synthetic-key'));
  const old = readFileSync(file);
  const current = settings.config;
  for (const invalid of [setup('new-key', { maxUsd: '0' }), setup('new-key', { endpoint: 'unrequested' })]) {
    assert.throws(() => settings.prepare(invalid), error => error.status === 400 && error.code === 'AI_CONFIG_INVALID');
    assert.strictEqual(settings.config, current);
    assert.deepEqual(readFileSync(file), old);
  }
  assert.equal(settings.config, first);

  const blockedPath = join(directory, 'blocked', 'ai-authoring.json');
  mkdirSync(blockedPath, { recursive: true });
  const failing = createAuthoringSettings({ file: blockedPath, config: current });
  const beforeFailure = failing.config;
  assert.throws(() => failing.prepare(setup('replacement-key')).persist(), error => error.status === 503 && error.code === 'AI_CONFIG_SAVE_FAILED');
  assert.strictEqual(failing.config, beforeFailure);
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.ai-authoring-')), []);
  assert.deepEqual(readFileSync(file), old);
});

test('escaped keys are rejected before commit when stored JSON exceeds 8192 bytes and accepted bytes reopen exactly', t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  const settings = createAuthoringSettings({ file, env: {} });
  const acceptedKey = '\\'.repeat(3900);
  const accepted = settings.prepare(setup(acceptedKey));
  accepted.persist();
  const stored = readFileSync(file);
  assert.ok(stored.length <= 8192);
  assert.equal(readdirSync(directory).some(name => name.startsWith('.ai-authoring-') && name.endsWith('.tmp')), false);
  const reopened = createAuthoringSettings({ file, env: {} });
  assert.equal(reopened.config.apiKey, acceptedKey);
  assert.deepEqual(readFileSync(file), stored);

  const before = settings.config, previous = readFileSync(file);
  assert.throws(() => settings.prepare(setup('\\'.repeat(4096))), error => error.status === 400 && error.code === 'AI_CONFIG_INVALID');
  assert.strictEqual(settings.config, before);
  assert.deepEqual(readFileSync(file), previous);
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.ai-authoring-')), []);
});

test('local plaintext file is mode 0600 on POSIX; this makes no Windows ACL claim', { skip: process.platform === 'win32' }, t => {
  const directory = tempDir(t), file = join(directory, 'ai-authoring.json');
  save(createAuthoringSettings({ file, env: {} }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('settings file cannot be placed inside static assets', t => {
  const directory = tempDir(t), root = join(directory, 'public'), data = join(directory, 'data');
  mkdirSync(root); mkdirSync(data);
  assert.doesNotThrow(() => assertAuthoringSettingsLocation(join(data, 'ai-authoring.json'), root));
  assert.throws(() => assertAuthoringSettingsLocation(join(root, 'ai-authoring.json'), root), /outside public assets/);
  assert.throws(() => assertAuthoringSettingsLocation(join(root, 'not-yet-created', 'ai-authoring.json'), root), /outside public assets/);
  assert.throws(() => assertAuthoringSettingsLocation(join(data, 'other.json'), root), /outside public assets/);
  assert.throws(() => assertAuthoringSettingsLocation('ai-authoring.json', root), /outside public assets/);
  assert.doesNotThrow(() => assertAuthoringSettingsLocation(join(data, 'not-yet-created', 'ai-authoring.json'), root));
  assert.doesNotThrow(() => assertAuthoringSettingsLocation(undefined, root));
});

test('settings file cannot be placed through a static-root symlink alias', t => {
  const directory = tempDir(t), root = join(directory, 'public'), alias = join(directory, 'public-alias');
  mkdirSync(root);
  try { symlinkSync(root, alias, 'junction'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('this Windows account cannot create symlinks');
    throw error;
  }
  assert.throws(() => assertAuthoringSettingsLocation(join(alias, 'ai-authoring.json'), root), /outside public assets/);
});

test('fixed settings and operation temporary names stay ignored in an alternate repository data directory', () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = ['.task-data/ai-authoring.json', '.task-data/.ai-authoring-check.tmp'];
  for (const path of paths) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', path], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `${path} must be ignored`);
  }
});
