import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { createLegacyV4 } from './fixtures/legacy-v4.mjs';

const existingTables = ['users', 'projects', 'tasks', 'extension_revisions', 'extension_selections',
  'extension_evidence', 'extension_approvals', 'extension_history', 'extension_authored'];
const authoringTables = ['authoring_budget', 'authoring_conversations'];
const allDataTables = [...existingTables, ...authoringTables, 'extensions', 'extension_revision_links', 'extension_conversation_links'];
const snapshot = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-data-'));
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'keir-authoring-data-'))); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path: join(directory, 'app.sqlite') };
}
function insertConversation(db, overrides = {}) {
  const row = { id: 'conversation-1', owner_id: 'maya', creation_operation_id: 'operation-1', version: 1, run_id: 'run-1',
    status: 'RUNNING', cancel_requested: 0, updated_at: 123, state: '{"private":"continuation"}',
    operations: '[{"id":"operation-1"}]', view: '{"messages":[]}', ...overrides };
  db.prepare(`INSERT INTO authoring_conversations(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}

test('populated v3 migrates once, retaining every native/lifecycle byte and existing budget on reopen', t => {
  const { path } = fixture(t);
  let db = createLegacyV4(path);
  db.exec('DROP TABLE authoring_conversations; DROP TABLE authoring_budget; PRAGMA user_version=3');
  db.prepare("UPDATE tasks SET notes=? WHERE id=(SELECT id FROM tasks LIMIT 1)").run('Original native notes: \u0000\u03bb');
  const revision = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='owner-a'").get().id;
  db.prepare('INSERT INTO extension_authored VALUES (?, ?, ?, ?, ?, ?)').run(revision, 'owner-a', 'Original source',
    Buffer.from([0, 255, 195, 169, 10]), Buffer.from([123, 0, 255, 125]), '{"independent":"\u03bb"}');
  db.prepare('INSERT INTO extension_evidence VALUES (?, ?, ?, ?, ?, ?, ?)').run('evidence-1', 'owner-a', revision,
    'exact identity', 'exact suite identity', '{"original":"\u03bb"}', 1);
  db.prepare('INSERT INTO extension_approvals VALUES (?, ?, ?)').run('owner-a', revision, 'evidence-1');
  db.prepare('UPDATE extension_states SET draft_version=7, draft_id=? WHERE owner_id=?').run(revision, 'owner-a');
  const original = snapshot(db, existingTables);
  db.close();

  db = openData(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(db.prepare("SELECT draft_revision_id FROM extensions WHERE owner_id='owner-a'").get().draft_revision_id, revision);
  assert.deepEqual(snapshot(db, existingTables), original);
  assert.deepEqual({ ...db.prepare('SELECT * FROM authoring_budget').get() }, { id: 1, reserved_micros: 0 });
  assert.equal(db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 0);
  db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(9007199254740991);
  insertConversation(db, { owner_id: 'owner-a' });
  const authoring = snapshot(db, authoringTables);
  db.close();
  db = openData(path);
  assert.deepEqual(snapshot(db, existingTables), original);
  assert.deepEqual(snapshot(db, authoringTables), authoring);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('schema 4 enforces ownership, identity, statuses, integer bounds and byte quotas', t => {
  const { path } = fixture(t), db = openData(path);
  insertConversation(db);
  assert.throws(() => insertConversation(db, { id: 'conversation-2' }), /UNIQUE/);
  assert.throws(() => insertConversation(db, { creation_operation_id: 'operation-2' }), /UNIQUE/);
  for (const [index, row] of [
    { owner_id: 'missing' },
    { version: -1 }, { version: 9007199254740992 }, { version: 0.5 }, { status: 'FINISHED' },
    { cancel_requested: -1 }, { cancel_requested: 2 }, { cancel_requested: 0.5 },
    { updated_at: -1 }, { updated_at: 0.5 }, { state: null }, { operations: null }, { view: null },
  ].entries()) {
    assert.throws(() => insertConversation(db, { id: `invalid-${index}`, creation_operation_id: `invalid-${index}`, ...row }));
  }
  insertConversation(db, { id: 'other-owner', owner_id: 'leo' });
  for (const status of ['IDLE', 'RUNNING', 'CANCELLING', 'AWAITING_USER', 'REVIEW_AVAILABLE', 'CANCELLED', 'BLOCKED', 'INTERRUPTED']) {
    db.prepare('UPDATE authoring_conversations SET status=? WHERE id=?').run(status, 'conversation-1');
  }
  db.prepare('UPDATE authoring_conversations SET version=?, cancel_requested=1, updated_at=0 WHERE id=?').run(9007199254740991, 'conversation-1');
  assert.throws(() => db.prepare("DELETE FROM users WHERE id='maya'").run(), /FOREIGN KEY/);
  assert.deepEqual(db.prepare("PRAGMA index_info('authoring_conversations_owner')").all().map(row => row.name), ['owner_id', 'updated_at']);

  db.exec('DELETE FROM authoring_conversations');
  const boundary = { state: '\u00e9'.repeat(57344), operations: '\u00e9'.repeat(8192), view: '\u00e9'.repeat(65536) };
  insertConversation(db, boundary);
  assert.equal(db.prepare('SELECT length(CAST(state AS BLOB))+length(CAST(operations AS BLOB))+length(CAST(view AS BLOB)) n FROM authoring_conversations').get().n, 262144);
  for (const field of ['state', 'operations', 'view']) {
    assert.throws(() => db.prepare(`UPDATE authoring_conversations SET ${field}=?`).run(boundary[field] + 'x'), /CHECK/);
  }
  db.exec('DELETE FROM authoring_conversations');
  assert.throws(() => insertConversation(db, { state: '', operations: '', view: '\u00e9'.repeat(65536) + 'x' }), /CHECK/);
  assert.throws(() => insertConversation(db, { state: '', operations: '\u00e9'.repeat(8192) + 'x', view: '' }), /CHECK/);
  insertConversation(db, { state: '', operations: '', view: '', version: 0 });

  for (const value of [-1, 9007199254740992, 0.5, null]) {
    assert.throws(() => db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(value));
  }
  for (const value of [0, 9007199254740991]) db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(value);
  assert.throws(() => db.prepare('INSERT INTO authoring_budget VALUES (1, 0)').run(), /UNIQUE/);
  assert.throws(() => db.prepare('INSERT INTO authoring_budget VALUES (2, 0)').run(), /CHECK/);
  db.close();
});

test('schema 4 migration rolls back partial DDL and rejects unsupported versions without resetting rows', t => {
  const { path } = fixture(t);
  let db = createLegacyV4(path);
  const original = snapshot(db, existingTables);
  db.exec('DROP TABLE authoring_conversations; DROP TABLE authoring_budget; CREATE TABLE authoring_conversations(conflict TEXT); PRAGMA user_version=3');
  db.close();
  assert.throws(() => openData(path), /already exists/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='authoring_budget'").get().n, 0);
  assert.deepEqual(snapshot(db, existingTables), original);
  db.exec('DROP TABLE authoring_conversations; CREATE TABLE authoring_budget(id INTEGER PRIMARY KEY, reserved_micros INTEGER); INSERT INTO authoring_budget VALUES (1, 1234)');
  db.close();
  assert.throws(() => openData(path), /already exists/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 1234);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => openData(path), /Unsupported database version/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 1234);
  assert.deepEqual(snapshot(db, existingTables), original);
  db.close();
});

test('reset verifies both authoring tables, backs up conversations and preserves all reservations through repeated reset', async t => {
  const { path, directory } = fixture(t);
  let db = openData(path);
  insertConversation(db);
  insertConversation(db, { id: 'conversation-2', creation_operation_id: 'operation-2', status: 'INTERRUPTED' });
  db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(987654321);
  const original = snapshot(db, allDataTables);
  db.close();
  for (const sql of ["UPDATE authoring_conversations SET state='different'", 'UPDATE authoring_budget SET reserved_micros=0']) {
    await assert.rejects(resetData(directory, true, async (source, destination) => {
      await backup(source, destination);
      const copy = new DatabaseSync(destination);
      copy.exec(sql);
      copy.close();
    }), /Backup differs/);
    db = openData(path);
    assert.deepEqual(snapshot(db, allDataTables), original);
    db.close();
  }
  const backupPath = await resetData(directory, true);
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  assert.deepEqual(snapshot(copy, allDataTables), original);
  copy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    db = openData(path);
    assert.equal(db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 0);
    assert.deepEqual({ ...db.prepare('SELECT * FROM authoring_budget').get() }, { id: 1, reserved_micros: 987654321 });
    assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 9);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
    if (attempt === 0) await resetData(directory, true);
  }
});

test('failed reset rolls conversation deletion back without releasing reserved budget', async t => {
  const { path, directory } = fixture(t);
  let db = openData(path);
  insertConversation(db);
  db.exec(`UPDATE authoring_budget SET reserved_micros=2345;
    CREATE TRIGGER fail_authoring_reset BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'seed blocked'); END;`);
  const original = snapshot(db, allDataTables);
  db.close();
  await assert.rejects(resetData(directory, true), /seed blocked/);
  db = openData(path);
  assert.deepEqual(snapshot(db, allDataTables), original);
  db.close();
});
