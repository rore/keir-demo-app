import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';

const existingTables = ['users', 'projects', 'tasks', 'extension_revisions', 'extension_selections',
  'extension_evidence', 'extension_approvals', 'extension_history', 'extension_authored'];
const authoringHistoryTables = ['authoring_messages', 'authoring_operations', 'authoring_dispatches'];
const authoringTables = ['authoring_budget', 'authoring_conversations', ...authoringHistoryTables];
const allDataTables = [...existingTables, ...authoringTables, 'extensions', 'extension_revision_links', 'extension_conversation_links'];
const snapshot = (db, tables) => Object.fromEntries(tables.map(table => [table,
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-data-'));
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'keir-authoring-data-'))); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path: join(directory, 'app.sqlite') };
}
function insertConversation(db, overrides = {}) {
  const row = { id: 'conversation-1', owner_id: 'maya', creation_operation_id: 'operation-1', version: 1, run_id: 'run-1',
    status: 'RUNNING', cancel_requested: 0, updated_at: 123, state: '{"private":"continuation"}',
    operations: '[{"id":"operation-1"}]', view: '{"messages":[]}', created_at: 123, ...overrides };
  db.prepare(`INSERT INTO authoring_conversations(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}

test('current schema retains ownership, identity, statuses, integer bounds and bounded projection bytes', t => {
  const { path } = fixture(t), db = openData(path);
  insertConversation(db);
  assert.throws(() => insertConversation(db, { id: 'conversation-2' }), /UNIQUE/);
  assert.throws(() => insertConversation(db, { creation_operation_id: 'operation-2' }), /UNIQUE/);
  for (const [index, row] of [
    { owner_id: 'missing' },
    { version: -1 }, { version: 9007199254740992 }, { version: 0.5 }, { status: 'FINISHED' },
    { cancel_requested: -1 }, { cancel_requested: 2 }, { cancel_requested: 0.5 },
    { updated_at: -1 }, { updated_at: 0.5 }, { state: null }, { operations: null }, { view: null },
    { created_at: null }, { created_at: -1 }, { created_at: 0.5 }, { created_at: 9007199254740992 },
  ].entries()) {
    assert.throws(() => insertConversation(db, { id: `invalid-${index}`, creation_operation_id: `invalid-${index}`, ...row }));
  }
  insertConversation(db, { id: 'other-owner', owner_id: 'leo' });
  for (const status of ['IDLE', 'RUNNING', 'CANCELLING', 'AWAITING_USER', 'REVIEW_AVAILABLE', 'CANCELLED', 'BLOCKED', 'INTERRUPTED']) {
    db.prepare('UPDATE authoring_conversations SET status=? WHERE id=?').run(status, 'conversation-1');
  }
  db.prepare('UPDATE authoring_conversations SET version=?, cancel_requested=1, updated_at=0 WHERE id=?').run(9007199254740991, 'conversation-1');
  assert.throws(() => db.prepare("DELETE FROM users WHERE id='maya'").run(), /FOREIGN KEY/);
  assert.deepEqual(db.prepare("PRAGMA index_info('authoring_conversations_owner')").all().map(row => row.name), ['owner_id', 'created_at', 'id']);

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

test('reset verifies every authoring table, backs up historical receipts and preserves all reservations through repeated reset', async t => {
  const { path, directory } = fixture(t);
  let db = openData(path);
  insertConversation(db);
  insertConversation(db, { id: 'conversation-2', creation_operation_id: 'operation-2', status: 'INTERRUPTED' });
  db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run('conversation-1', 'maya', 1, 'message-1', '{"id":"message-1","receipt":{"evidenceId":"proof"}}');
  db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run('conversation-1', 'maya', 'operation-1', 'exact-body-hash', 'run-1', 1);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run('conversation-1', 'maya', 'run-1', 1, 'provider', null, 999, 'UNKNOWN');
  db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(987654321);
  db.prepare("UPDATE tasks SET notes=? WHERE owner_id='maya'").run('original\u0000native notes');
  const original = snapshot(db, allDataTables);
  db.close();
  for (const sql of ["UPDATE authoring_conversations SET state='different'", 'UPDATE authoring_budget SET reserved_micros=0',
    'DELETE FROM authoring_messages', 'DELETE FROM authoring_dispatches', 'DELETE FROM authoring_dispatches; DELETE FROM authoring_operations',
    "UPDATE tasks SET notes='original' || char(0) || 'altered' WHERE owner_id='maya'"]) {
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
  assert.equal(Buffer.from(copy.prepare("SELECT CAST(notes AS BLOB) notes FROM tasks WHERE owner_id='maya' LIMIT 1").get().notes).toString(), 'original\u0000native notes');
  copy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    db = openData(path);
    assert.equal(db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 0);
    for (const table of authoringHistoryTables) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
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
  db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run('conversation-1', 'maya', 1, 'message-1', '{"id":"message-1","receipt":{"evidenceId":"proof"}}');
  db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run('conversation-1', 'maya', 'operation-1', 'exact-body-hash', 'run-1', 1);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run('conversation-1', 'maya', 'run-1', 1, 'provider', null, 2345, 'UNKNOWN');
  db.exec('UPDATE authoring_budget SET reserved_micros=2345');
  const original = snapshot(db, allDataTables);
  db.close();
  await assert.rejects(resetData(directory, true, async (source, backupPath) => {
    await backup(source, backupPath);
    source.exec("CREATE TEMP TRIGGER fail_authoring_reset BEFORE INSERT ON main.users BEGIN SELECT RAISE(ABORT, 'seed blocked'); END");
  }), /seed blocked/);
  db = openData(path);
  assert.deepEqual(snapshot(db, allDataTables), original);
  db.close();
});

test('current schema enforces owner/run lineage and immutable creation time and dispatch outcomes', t => {
  const { path } = fixture(t), db = openData(path);
  insertConversation(db, { id: 'conversation', created_at: 1, run_id: 'run' });
  db.exec("INSERT INTO authoring_operations VALUES ('conversation','maya','op','hash','run',1)");
  db.exec("INSERT INTO authoring_dispatches VALUES ('conversation','maya','run',1,'provider',NULL,99,NULL)");
  db.close();
  const reopened = openData(path);
  assert.throws(() => reopened.exec('UPDATE authoring_conversations SET created_at=2'), /immutable/);
  reopened.exec('UPDATE authoring_conversations SET created_at=created_at');
  for (const sql of ["UPDATE authoring_dispatches SET reserved_micros=0", "UPDATE authoring_dispatches SET outcome='invalid'",
    "INSERT INTO authoring_messages VALUES ('conversation','leo',1,'foreign','{}')",
    "INSERT INTO authoring_operations VALUES ('conversation','leo','foreign','hash','foreign-run',1)",
    "INSERT INTO authoring_dispatches VALUES ('conversation','leo','run',2,'tool','call',0,NULL)",
    "INSERT INTO authoring_dispatches VALUES ('conversation','maya','missing-run',2,'tool','call',0,NULL)"])
    assert.throws(() => reopened.exec(sql));
  reopened.exec("UPDATE authoring_dispatches SET outcome='UNKNOWN'");
  assert.throws(() => reopened.exec("UPDATE authoring_dispatches SET outcome='SUCCESS'"), /immutable/);
  assert.throws(() => reopened.exec('UPDATE authoring_dispatches SET reserved_micros=0'), /immutable/);
  assert.equal(reopened.prepare('SELECT reserved_micros FROM authoring_dispatches').get().reserved_micros, 99);
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []); reopened.close();
});
