import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all()
      .map(column => column.type === 'TEXT' ? `CAST(${column.name} AS BLOB) AS ${column.name}` : column.name);
    return [name, db.prepare(`SELECT ${columns.join(',')} FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))];
  }));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-deletion-storage-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openData(path);
  const { revisionId: revision, extensionId: extension } = seedTaskEffectBinding(db);
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

test('fresh schema validates deletion timestamps and retains tombstones through reopen', t => {
  const { db, path, extension } = fixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
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
  assert.equal(reset.prepare('SELECT count(*) n FROM extensions').get().n, 0);
  integrity(reset); reset.close();
});
