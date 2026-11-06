import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { acquireDataLock, openData, resetData, taskService } from '../src/data.mjs';
import { start } from '../src/server.mjs';
import { createApp } from '../src/app.mjs';
import { createAuthoringSettings } from '../src/authoring-settings.mjs';
import { nativeEffectService, seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

async function reservePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

test('real startup refuses another server/reset and a verified backup starts in a new directory', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await reservePort();
  const server = await start({ directory, port });
  const proofRows = db => ['extension_evidence', 'extension_approvals', 'task_effect_receipts']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  let saved, records, event, receipt, payload;
  try {
    await assert.rejects(start({ directory, port }), /locked/);
    await assert.rejects(resetData(directory, true), /locked/);
    const response = await fetch(`${server.origin}/api/session`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).users.length, 3);
    for (const path of ['/.data/app.sqlite', '/package.json', '/src/data.mjs', '/%2e%2e/package.json']) assert.ok([403, 404].includes((await fetch(server.origin + path)).status));
    saved = taskService(server.db).createProject('maya', { name: 'Saved before reset' });
    const binding = seedTaskEffectBinding(server.db);
    server.db.prepare("UPDATE extension_selections SET generation=1,revision_id=?,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'")
      .run(binding.revisionId, JSON.stringify(binding.pins));
    const tasks = taskService(server.db), effects = nativeEffectService(server.db);
    const task = tasks.createTask('maya', { projectId: saved.id, title: 'Before reset' });
    tasks.completeTask('maya', task.id);
    event = server.db.prepare("SELECT event_id FROM task_events WHERE hook_id='TaskCompleted' AND source_task_id=?").get(task.id).event_id;
    assert.ok(effects.claim('maya', event));
    payload = { projectId: saved.id, title: 'Created before reset' };
    receipt = effects.createTaskOnce('maya', effects.keyFor('maya', event), payload);
    assert.equal(receipt.effect, 'CONFIRMED');
    effects.finish('maya', event, { classification: 'COMPLETED' });
    records = proofRows(server.db);
  } finally { await server.close(); }
  assert.equal(existsSync(join(directory, 'app.lock')), false);
  const backupPath = await resetData(directory, true);
  const restoredDirectory = join(directory, 'restored');
  mkdirSync(restoredDirectory);
  copyFileSync(backupPath, join(restoredDirectory, 'app.sqlite'));
  const restored = await start({ directory: restoredDirectory, port });
  try {
    assert.deepEqual(taskService(restored.db).listProjects('maya').find(project => project.id === saved.id), saved);
    assert.deepEqual(proofRows(restored.db), records);
    const effects = nativeEffectService(restored.db);
    assert.deepEqual(effects.createTaskOnce('maya', effects.keyFor('maya', event), payload), receipt);
    assert.deepEqual(proofRows(restored.db), records);
  } finally { await restored.close(); }
});

function withSql(path, sql, options = {}) {
  const db = new DatabaseSync(path, options);
  try { db.exec(sql); } finally { db.close(); }
}

function restoreLegacy(path, version, { keepPending = false } = {}) {
  writeFileSync(path, gunzipSync(readFileSync(new URL('./fixtures/daymark-shipped-v11.sqlite.gz', import.meta.url))));
  if (!keepPending) withSql(path, "UPDATE task_completion_events SET state='STARTED' WHERE state='PENDING'");
  if (version === 10)
    withSql(path, 'ALTER TABLE tasks DROP COLUMN due_at; ALTER TABLE tasks DROP COLUMN priority; PRAGMA user_version=10');
}

for (const version of [10, 11]) test('v' + version + ' upgrades once, preserving task bytes, selection and event evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-task-fields-upgrade-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  restoreLegacy(path, version);
  const original = readFileSync(path);
  await assert.rejects(resetData(directory, true, () => assert.fail('legacy reset called backup')), /Unsupported database version/);
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(directory), ['app.sqlite']);

  const legacy = new DatabaseSync(path, { readOnly: true });
  const queries = legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const columns = legacy.prepare(`PRAGMA table_info(${name})`).all();
    const project = (database, current) => {
      const table = current && name === 'task_completion_events' ? 'task_events'
        : current && name === 'extension_selections' ? 'legacy_extension_selections' : name;
      const fields = columns.map(({ name: field, type }) => {
        const column = current && field === 'created_task_id' ? 'affected_task_id' : field;
        return type === 'TEXT' ? 'CAST(' + column + ' AS BLOB) AS ' + field : column + ' AS ' + field;
      });
      const filter = current && ['legacy_extension_selections', 'task_events'].includes(table) ? " WHERE hook_id='TaskCompleted'" : '';
      return database.prepare('SELECT rowid AS saved_rowid,' + fields.join(',') + ' FROM ' + table + filter + ' ORDER BY rowid').all();
    };
    return project;
  });
  const snapshot = (database, current = false) => queries.map(project => project(database, current));
  const before = snapshot(legacy);
  legacy.close();
  const exec = DatabaseSync.prototype.exec;
  for (const boundary of ['CREATE TABLE task_events', 'ALTER TABLE task_effect_receipts', 'CREATE INDEX task_events_item', 'PRAGMA user_version=13']) {
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === boundary) {
        exec.call(this, sql);
        throw new Error('upgrade interrupted after version write');
      }
      const offset = sql.includes('ALTER TABLE extension_selections RENAME TO previous_selections') ? sql.indexOf(boundary) : -1;
      if (offset !== -1) {
        exec.call(this, sql.slice(0, offset));
        throw new Error('upgrade interrupted during rebuild');
      }
      return exec.call(this, sql);
    };
    try { assert.throws(() => openData(path), /upgrade interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    const rolledBack = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(rolledBack.prepare('PRAGMA user_version').get().user_version, version);
      assert.deepEqual(snapshot(rolledBack), before);
    } finally { rolledBack.close(); }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const upgraded = openData(path);
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual(snapshot(upgraded, true), before);
      assert.equal(upgraded.prepare("SELECT count(*) n FROM extension_selections WHERE hook_id='TaskCreated' AND generation=1 AND revision_id IS NULL AND binding_pins IS NULL").get().n, 3);
      if (version === 10)
        assert.deepEqual(upgraded.prepare('SELECT DISTINCT priority,due_at FROM tasks').all().map(Object.values), [['normal', null]]);
    } finally { upgraded.close(); }
  }
});

test('an unresolved older /1 admission prevents cutover without changing the database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-workflow-upgrade-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  restoreLegacy(path, 11, { keepPending: true });
  const original = readFileSync(path);
  assert.throws(() => openData(path), /unresolved pending task events/);
  assert.deepEqual(readFileSync(path), original);
});

async function assertEntryPointsPreserveData(directory, expected, expectedReset = expected) {
  const names = readdirSync(directory);
  const bytes = names.map(name => readFileSync(join(directory, name)));
  const unchanged = () => {
    assert.deepEqual(readdirSync(directory), names);
    assert.deepEqual(names.map(name => readFileSync(join(directory, name))), bytes);
  };
  await assert.rejects(start({ directory, port: 0 }), expected);
  unchanged();
  const seed = spawnSync(process.execPath, ['scripts/demo-data.mjs', 'seed', '--data-dir', directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(seed.status, 1, seed.error?.message || seed.stderr);
  assert.match(seed.stderr, expected);
  unchanged();
  await assert.rejects(resetData(directory, true), expectedReset);
  unchanged();
}

test('startup, seed and reset reject unsupported databases without touching the main file or sidecars', async t => {
  const root = mkdtempSync(join(tmpdir(), 'keir-rejected-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = (path, suffix) => writeFileSync(path + suffix, 'Synthetic sidecar evidence');
  const version = value => path => {
    withSql(path, 'PRAGMA user_version=' + value);
    sidecar(path, '-journal');
  };
  for (const [name, fresh, mutate, expected] of [
    ['preview v9', true, version(9), /Unsupported database version/],
    ['unmarked', true, version(0), /Unsupported database version/],
    ['future', true, version(14), /Unsupported database version/],
    ['v10 marker on a different schema', true, path => withSql(path, 'PRAGMA user_version=10'), /Unsupported database (schema|version)/],
    ['current marker on legacy schema', true, path => { restoreLegacy(path, 10); withSql(path, 'PRAGMA user_version=13'); }, /Unsupported database schema/],
    ['empty file', false, path => writeFileSync(path, ''), /Unsupported database format/],
    ['invalid header with current marker', true, path => {
      const bytes = readFileSync(path);
      bytes[0] = 0;
      writeFileSync(path, bytes);
      sidecar(path, '-journal');
    }, /Unsupported database format/],
    ['truncated current database', true, path => writeFileSync(path, readFileSync(path).subarray(0, 100)), /database disk image is malformed/],
    ['different current schema', true, path => withSql(path, 'DROP TRIGGER task_receipt_immutable'), /Unsupported database schema/],
    ['broken owner reference', true, path => withSql(path, "UPDATE projects SET owner_id='missing'", { enableForeignKeyConstraints: false }), /Database integrity check failed/],
    ['WAL header', true, path => withSql(path, 'PRAGMA journal_mode=WAL'), /Unsupported database format/],
    ['WAL sidecar', true, path => sidecar(path, '-wal'), /Unsupported database format/],
    ['SHM sidecar', true, path => sidecar(path, '-shm'), /Unsupported database format/],
    ['super-journal pointer', true, path => {
      const target = join(dirname(path), 'untouched');
      writeFileSync(target, 'Unrelated fixture data');
      const magic = Buffer.from('d9d505f920a163d7', 'hex');
      const pointer = Buffer.from(target), footer = Buffer.alloc(16);
      footer.writeUInt32BE(pointer.length, 0);
      footer.writeUInt32BE(pointer.reduce((sum, byte) => sum + byte, 0), 4);
      magic.copy(footer, 8);
      writeFileSync(path + '-journal', Buffer.concat([magic, Buffer.alloc(600), pointer, footer]));
    }, /Unsupported database format/],
    ['orphan journal', false, path => sidecar(path, '-journal'), /Unsupported database format/],
    ['orphan WAL', false, path => sidecar(path, '-wal'), /Unsupported database format/],
    ['orphan SHM', false, path => sidecar(path, '-shm'), /Unsupported database format/],
  ]) {
    await t.test(name, async () => {
      const directory = mkdtempSync(join(root, 'case-')), path = join(directory, 'app.sqlite');
      if (fresh) openData(path).close();
      mutate(path);
      await assertEntryPointsPreserveData(directory, expected);
    });
  }
});

test('a hot rollback journal is validated on a disposable copy before original recovery', async t => {
  for (const [version, wrongSchema] of [[13, false], [13, true], [10, false], [10, true]]) await t.test(
    `v${version} ${wrongSchema ? 'rejects a different recovered schema' : 'recovers the exact schema'}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-hot-journal-')), path = join(directory, 'app.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (version === 10) restoreLegacy(path, version);
    const db = version === 10 ? new DatabaseSync(path, { readOnly: true }) : openData(path);
    const tasks = db.prepare('SELECT id, notes FROM tasks ORDER BY id').all();
    db.close();
    if (wrongSchema) withSql(path, 'DROP TRIGGER task_receipt_immutable');
    const original = readFileSync(path);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA cache_size=5; BEGIN IMMEDIATE; PRAGMA user_version=13; UPDATE tasks SET notes=printf('%04000d', 1)");
      console.log('dirty');
      setInterval(() => {}, 60_000);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const [ready] = await Promise.race([once(child.stdout, 'data'), closed]);
      assert.match(String(ready), /dirty/, stderr);
    } finally { child.kill('SIGKILL'); await closed; }
    assert.notDeepEqual(readFileSync(path), original);
    assert.throws(() => withSql(path, 'PRAGMA user_version', { readOnly: true }), { errcode: 776 });
    if (version === 10) {
      const journal = readFileSync(path + '-journal'), dirty = readFileSync(path);
      // Model a crash after the new marker reaches disk, with the v10 header still in the rollback journal.
      dirty.writeUInt32BE(13, 60);
      writeFileSync(path, dirty);
      await assert.rejects(resetData(directory, true, () => assert.fail('legacy reset called backup')), /Unsupported database version/);
      assert.deepEqual(readFileSync(path), dirty);
      assert.deepEqual(readFileSync(path + '-journal'), journal);
    }
    if (wrongSchema) {
      await assertEntryPointsPreserveData(directory, /Unsupported database schema/, version === 10 ? /Unsupported database version/ : undefined);
    } else {
      const recovered = await start({ directory, port: await reservePort() });
      try {
        assert.deepEqual(recovered.db.prepare('SELECT id, notes FROM tasks ORDER BY id').all(), tasks);
        assert.equal(recovered.db.prepare('PRAGMA user_version').get().user_version, 13);
      }
      finally { await recovered.close(); }
      assert.deepEqual(readdirSync(directory), ['app.sqlite']);
    }
  });
});

test('CLI starts using only its own child process/data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-cli-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs', '--data-dir', directory, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Child exited before ready: ${code}`)));
  });
  await ready;
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  // The fixture owns this child; no operator process is signalled.
  child.kill('SIGTERM'); await once(child, 'exit');
  // Windows force-terminates a signalled child, so a lock can remain deliberately stale.
  if (existsSync(join(directory, 'app.lock'))) assert.throws(() => acquireDataLock(directory), /stale lock/);
  const db = openData(join(directory, 'app.sqlite')); assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 3); db.close();
});

test('real startup wires saved local setup through hot save and restart without a provider call', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-startup-settings-'));
  const data = join(directory, 'data'), staticRoot = join(directory, 'public'); mkdirSync(staticRoot);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let server;
  t.after(async () => { await server?.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, options = {}) => fetch(server.origin + path,
    { ...options, headers: { connection: 'close', ...options.headers } });
  const login = async () => {
    const bootstrap = await (await request('/api/session')).json();
    const response = await request('/api/session', { method: 'POST', headers: { origin: server.origin,
      'content-type': 'application/json', 'x-session-context': bootstrap.contextToken }, body: JSON.stringify({ userId: 'maya' }) });
    const value = await response.json(); assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], 'x-session-context': value.contextToken };
  };
  server = await start({ directory: data, port, staticRoot }); let auth = await login();
  const saved = await request('/api/authoring/setup', { method: 'POST', headers: { ...auth, origin: server.origin,
    'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', model: 'gpt-5.6-terra', apiKey: 'synthetic-startup-key', maxUsd: '1' }) });
  assert.equal(saved.status, 200); const dto = await saved.json(); assert.equal(dto.configuration.source, 'local');
  await server.close(); server = await start({ directory: data, port, staticRoot }); auth = await login();
  const reopened = await (await request('/api/authoring/setup', { headers: auth })).json();
  assert.deepEqual(reopened, dto);
  assert.equal(server.db.prepare('SELECT reserved_micros n FROM authoring_budget').get().n, 0);
  for (const path of ['/ai-authoring.json', '/.data/ai-authoring.json', '/data/ai-authoring.json']) {
    assert.ok([403, 404].includes((await request(path)).status));
  }
});

test('stale locks are never guessed safe or removed by startup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-stale-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = '{"pid":0,"token":"deliberately-stale"}';
  writeFileSync(join(directory, 'app.lock'), marker);
  assert.throws(() => acquireDataLock(directory), /stale lock/);
  assert.equal(readFileSync(join(directory, 'app.lock'), 'utf8'), marker);
});

test('anonymous static requests cannot follow an asset junction into private AI settings', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-static-settings-'));
  const staticRoot = join(directory, 'public'), data = join(directory, 'private-data');
  mkdirSync(staticRoot); mkdirSync(data); writeFileSync(join(staticRoot, 'index.html'), '<p>Public app</p>');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  try { symlinkSync(data, join(staticRoot, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('this Windows account cannot create junctions');
    throw error;
  }
  const file = join(data, 'ai-authoring.json'), settings = createAuthoringSettings({ file, env: {} });
  settings.prepare({ provider: 'openai', model: 'gpt-5.6-terra', apiKey: 'synthetic-private-junction-key', maxUsd: '1' }).persist();
  const db = openData(':memory:'), app = await createApp({ db, staticRoot, origin: 'http://127.0.0.1:32123', authoringSettingsFile: file });
  try {
    for (const path of ['/alias/ai-authoring.json', '/alias/%61i-authoring.json']) {
      const response = await app.inject({ url: path, headers: { host: '127.0.0.1:32123' } });
      assert.ok([403, 404].includes(response.statusCode));
      assert.equal(response.body.includes('synthetic-private-junction-key'), false);
    }
    const publicPage = await app.inject({ url: '/', headers: { host: '127.0.0.1:32123' } });
    assert.equal(publicPage.statusCode, 200); assert.equal(publicPage.body, '<p>Public app</p>');
  } finally { await app.close(); db.close(); }
});
