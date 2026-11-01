import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDataLock, openData, resetData } from '../src/data.mjs';
import { start } from '../src/server.mjs';

test('real startup refuses another server/reset and release preserves persisted data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = await start({ directory, port });
  try {
    await assert.rejects(start({ directory, port }), /locked/);
    await assert.rejects(resetData(directory, true), /locked/);
    const response = await fetch(`${server.origin}/api/session`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).users.length, 3);
    for (const path of ['/.data/app.sqlite', '/package.json', '/src/data.mjs', '/%2e%2e/package.json']) assert.ok([403, 404].includes((await fetch(server.origin + path)).status));
  } finally { await server.close(); }
  assert.equal(existsSync(join(directory, 'app.lock')), false);
  const backupPath = await resetData(directory, true);
  assert.equal(existsSync(backupPath), true);
});

test('CLI starts using only its own child process/data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs', '--data-dir', directory, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
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

test('stale locks are never guessed safe or removed by startup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-stale-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = '{"pid":0,"token":"deliberately-stale"}';
  writeFileSync(join(directory, 'app.lock'), marker);
  assert.throws(() => acquireDataLock(directory), /stale lock/);
  assert.equal(readFileSync(join(directory, 'app.lock'), 'utf8'), marker);
});
