import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';

const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all()
      .map(column => column.type === 'TEXT' ? `CAST(${column.name} AS BLOB) AS ${column.name}` : column.name);
    return [name, db.prepare(`SELECT ${columns.join(',')} FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))];
  }));

function fixture(t, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-deletion-storage-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openData(path);
  if (legacy) db.exec('ALTER TABLE extensions DROP COLUMN deleted_at; PRAGMA user_version=6;');
  const revision = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='maya'").get().id;
  const extension = db.prepare('SELECT extension_id FROM extension_revision_links WHERE revision_id=?').get(revision).extension_id;
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revision, 'maya', 'Original', Buffer.from([0, 255, 1]), Buffer.from([255, 0]), '{ "cases": [] }');
  db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run('proof', 'maya', revision, 'identity', 'suite', '{ "exact":"\\u0000" }', 1);
  db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('maya', revision, 'proof');
  db.prepare('UPDATE extensions SET creation_operation_id=?,creation_hash=?,draft_revision_id=?,draft_version=8 WHERE id=?')
    .run('create-original', 'exact-hash', revision, extension);
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('conversation', 'maya', 'create-conversation', 1, 'run',
    'INTERRUPTED', 0, 456, '{"opaque":"\\u0000λ"}', '[{"id":"operation"}]', '{"messages":[]}', 123);
  db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run('conversation', 'maya', extension, 'REVISE', revision, 1);
  db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run('conversation', 'maya', 1, 'message', '{ "receipt": { "revisionId": "original" } }');
  db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run('conversation', 'maya', 'operation', 'body-hash', 'run', 1);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run('conversation', 'maya', 'run', 1, 'provider', null, 321, 'UNKNOWN');
  db.exec('UPDATE authoring_budget SET reserved_micros=321;');
  db.prepare('UPDATE tasks SET notes=? WHERE id=(SELECT id FROM tasks LIMIT 1)').run('original\u0000λ');
  return { directory, path, db, extension };
}

function integrity(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
}

test('schema 6 migration adds only nullable deletion metadata and preserves every original row and schema object', t => {
  const { db, path } = fixture(t, true), before = snapshot(db);
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name!='extensions' ORDER BY type,name").all();
  db.close();
  let upgraded = openData(path);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  const after = snapshot(upgraded);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [table, rows] of Object.entries(before)) {
    const actual = table === 'extensions' ? after[table].map(({ deleted_at, ...row }) => { assert.equal(deleted_at, null); return row; }) : after[table];
    assert.deepEqual(actual, rows, table);
  }
  assert.deepEqual(upgraded.prepare("SELECT type,name,sql FROM sqlite_master WHERE name!='extensions' ORDER BY type,name").all(), schema);
  integrity(upgraded);
  const first = snapshot(upgraded); upgraded.close(); upgraded = openData(path);
  assert.deepEqual(snapshot(upgraded), first); integrity(upgraded); upgraded.close();
});

test('failed additive migration rolls back the column, version and all original records', t => {
  const { db, path } = fixture(t, true), before = snapshot(db);
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(); db.close();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('ADD COLUMN deleted_at')) throw new Error('injected migration failure');
    return result;
  };
  try { assert.throws(() => openData(path), /injected migration failure/); } finally { DatabaseSync.prototype.exec = exec; }
  const unchanged = new DatabaseSync(path);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 6);
  assert.deepEqual(snapshot(unchanged), before);
  assert.deepEqual(unchanged.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), schema); unchanged.close();
  const recovered = openData(path); integrity(recovered); recovered.close();
});

test('fresh schema validates deletion timestamps and retains tombstones through reopen', t => {
  const { db, path, extension } = fixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(db.prepare('SELECT deleted_at FROM extensions WHERE id=?').get(extension).deleted_at, null);
  for (const timestamp of [-1, 1.5, 'invalid']) assert.throws(() => db.prepare('UPDATE extensions SET deleted_at=? WHERE id=?').run(timestamp, extension));
  for (const timestamp of [0, 123, null, 9007199254740991]) db.prepare('UPDATE extensions SET deleted_at=? WHERE id=?').run(timestamp, extension);
  const before = snapshot(db); db.close();
  const reopened = openData(path); assert.deepEqual(snapshot(reopened), before); integrity(reopened); reopened.close();
});

test('reset backs up tombstones and all history, rejects deletion metadata mismatch and keeps unknown spending held', async t => {
  const { db, directory, path, extension } = fixture(t);
  db.prepare('UPDATE extensions SET deleted_at=789 WHERE id=?').run(extension);
  const before = snapshot(db); db.close();
  await assert.rejects(resetData(directory, true, async (source, backupPath) => {
    await backup(source, backupPath);
    const copy = new DatabaseSync(backupPath); copy.exec('UPDATE extensions SET deleted_at=NULL'); copy.close();
  }), /Backup differs/);
  const retained = openData(path); assert.deepEqual(snapshot(retained), before); retained.close();
  const backupPath = await resetData(directory, true);
  const copy = openData(backupPath); assert.deepEqual(snapshot(copy), before); integrity(copy); copy.close();
  const reset = openData(path);
  assert.equal(reset.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 321);
  assert.equal(reset.prepare('SELECT count(*) n FROM authoring_dispatches').get().n, 0);
  assert.ok(reset.prepare('SELECT count(*) n FROM extensions').get().n > 0);
  assert.equal(reset.prepare('SELECT count(*) n FROM extensions WHERE deleted_at IS NOT NULL').get().n, 0);
  integrity(reset); reset.close();
});
