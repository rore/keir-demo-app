import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openData } from '../src/data.mjs';

// Frozen V5 authoring DDL: the other V5 tables are unchanged by schema 6.
const legacyAuthoringDDL = `CREATE TABLE authoring_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  creation_operation_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
  run_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('IDLE','RUNNING','CANCELLING','AWAITING_USER','REVIEW_AVAILABLE','CANCELLED','BLOCKED','INTERRUPTED')),
  cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  state TEXT NOT NULL, operations TEXT NOT NULL, view TEXT NOT NULL, UNIQUE(id,owner_id), UNIQUE(owner_id,creation_operation_id),
  CHECK(length(CAST(state AS BLOB))+length(CAST(operations AS BLOB))+length(CAST(view AS BLOB))<=262144),
  CHECK(length(CAST(view AS BLOB))<=131072), CHECK(length(CAST(operations AS BLOB))<=16384)) STRICT;
  CREATE INDEX authoring_conversations_owner ON authoring_conversations(owner_id,updated_at);
  PRAGMA user_version=5;`;
const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(({ deleted_at, ...row }) => row)]));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-continuous-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const db = openData(path);
  db.exec('ALTER TABLE extensions DROP COLUMN deleted_at');
  db.exec('DROP TABLE authoring_dispatches; DROP TABLE authoring_messages; DROP TABLE authoring_operations; DROP TABLE authoring_conversations;');
  db.exec(legacyAuthoringDDL);
  return { db, path };
}
function insert(db, { id = 'conversation', state = { createdAt: 123, continuation: { opaque: '\u0000\u03bb' }, journal: [] },
  operations = [], payloads = [], view = `{ "messages": [${payloads.join(', ')}], "code": null, "review": null }` } = {}) {
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, 'maya', `create-${id}`, 50, 'run-49',
    'IDLE', 0, 456, JSON.stringify(state), JSON.stringify(operations), view);
}

test('V5 history migration preserves exact messages, receipts, operations, holds and opaque state beyond former count ceilings', t => {
  const { db, path } = fixture(t);
  const operations = Array.from({ length: 50 }, (_, i) => ({ id: `operation-${i}`, hash: createHash('sha256').update(`original-${i}`).digest('hex'), runId: `run-${i}`, version: i + 1 }));
  const payloads = Array.from({ length: 120 }, (_, i) => `{ "id": "message-${i}", "role":"${i % 2 ? 'assistant' : 'user'}", "text":"original \\u03bb ${i} } ] \\\"", "kind":"text"${i === 119 ? ', "receipt": { "revisionId":"revision", "evidenceId":"proof", "draftVersion":8, "suiteDigest":"suite" }' : ''} }`);
  const outcomes = ['SUCCESS', 'REJECTED', 'UNKNOWN', undefined];
  const journal = operations.flatMap((op, i) => [
    { runId: op.runId, ordinal: 1, kind: 'provider', reservedMicros: 12345, ...(outcomes[i % 4] && { outcome: outcomes[i % 4] }) },
    { runId: op.runId, ordinal: 2, kind: 'tool', callId: `call-${i}`, reservedMicros: 0, outcome: 'SUCCESS' },
  ]);
  const retained = { createdAt: 123, activeMs: 999999999, continuation: { opaque: '\u0000\u03bb' }, transport: { provider: 'old', policy: 'old' },
    counts: { calls: 50, tools: 50, inputs: 50 }, usage: { reservedMicros: 617250 }, handles: { revisionId: 'original' },
    pending: { question: 'Keep exact intent' }, inFlight: { ordinal: 1, kind: 'provider' }, dispatchOrdinal: 2 };
  const review = { revisionId: 'revision', evidenceId: 'proof', draftVersion: 8, suiteDigest: 'suite', eligible: true };
  insert(db, { operations, payloads, state: { ...retained, journal, inputIds: operations.map(op => op.id), callIds: ['old-call'] },
    view: ` { "review":${JSON.stringify(review)}, "messages": [ ${payloads.join(',\n')} ], "code":null } ` });
  db.exec('UPDATE authoring_budget SET reserved_micros=9007199254740991');
  const revision = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='maya'").get().id;
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revision, 'maya', 'Original', Buffer.from([0, 255, 195, 169]), Buffer.from([255, 0, 1]), '{ "cases": ["original"] }');
  db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run('original-proof', 'maya', revision, 'identity', 'suite', '{ "original":"\\u03bb" }', 1);
  db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('maya', revision, 'original-proof');
  const extension = db.prepare('SELECT extension_id FROM extension_revision_links WHERE revision_id=?').get(revision).extension_id;
  db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run('conversation', 'maya', extension, 'REVISE', revision, 1);
  const before = snapshot(db);
  db.close();
  let upgraded = openData(path);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(upgraded.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const after = snapshot(upgraded);
  for (const [table, rows] of Object.entries(before)) if (table !== 'authoring_conversations') assert.deepEqual(after[table], rows, table);
  const row = upgraded.prepare('SELECT * FROM authoring_conversations').get();
  assert.equal(row.created_at, 123);
  assert.deepEqual(JSON.parse(row.state), retained);
  assert.deepEqual(JSON.parse(row.view), { review, messages: [], code: null });
  assert.deepEqual(JSON.parse(row.operations), operations.slice(-1));
  assert.deepEqual(upgraded.prepare('SELECT payload FROM authoring_messages ORDER BY sequence').all().map(row => JSON.parse(row.payload)), payloads.map(payload => JSON.parse(payload)));
  assert.deepEqual(upgraded.prepare('SELECT sequence,message_id FROM authoring_messages ORDER BY sequence').all().map(row => [row.sequence, row.message_id]), payloads.map((_, i) => [i + 1, `message-${i}`]));
  assert.deepEqual(upgraded.prepare('SELECT operation_id,body_hash,run_id,admitted_version FROM authoring_operations ORDER BY rowid').all()
    .map(row => ({ id: row.operation_id, hash: row.body_hash, runId: row.run_id, version: row.admitted_version })), operations);
  assert.deepEqual(upgraded.prepare('SELECT run_id,ordinal,kind,call_id,reserved_micros,outcome FROM authoring_dispatches ORDER BY rowid').all()
    .map(row => ({ runId: row.run_id, ordinal: row.ordinal, kind: row.kind, callId: row.call_id, reservedMicros: row.reserved_micros, outcome: row.outcome })),
  journal.map(item => ({ ...item, callId: item.callId ?? null, outcome: item.outcome ?? null })));
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const first = snapshot(upgraded); upgraded.close(); upgraded = openData(path);
  assert.deepEqual(snapshot(upgraded), first);
  upgraded.close();
});

test('largest legacy view migrates without truncating original message text or inventing a receipt', t => {
  const { db, path } = fixture(t);
  const view = { messages: [{ id: 'long', role: 'user', kind: 'text', text: '' }], review: null, code: null };
  view.messages[0].text = 'x'.repeat(131072 - Buffer.byteLength(JSON.stringify(view)));
  assert.equal(Buffer.byteLength(JSON.stringify(view)), 131072);
  insert(db, { view: JSON.stringify(view) }); db.close();
  const upgraded = openData(path);
  const message = JSON.parse(upgraded.prepare('SELECT payload FROM authoring_messages').get().payload);
  assert.deepEqual(message, view.messages[0]); assert.equal(Object.hasOwn(message, 'receipt'), false);
  upgraded.close();
});

test('malformed legacy timestamps, messages, operation lineage and outcomes roll back every migration write', t => {
  const cases = [
    { state: {} }, { state: { createdAt: '123' } }, { state: { createdAt: -1 } },
    { payloads: ['{"text":"missing identity"}'] }, { payloads: ['{"id":"same"}', '{"id":"same"}'] },
    { operations: [{ id: 'op', hash: 'hash', runId: 'run', version: 1 }], state: { createdAt: 1, journal: [{ runId: 'foreign-run', ordinal: 1, kind: 'provider', reservedMicros: 1 }] } },
    { operations: [{ id: 'op', hash: 'hash', runId: 'run', version: 1 }], state: { createdAt: 1, journal: [{ runId: 'run', ordinal: 1, kind: 'provider', reservedMicros: 1, outcome: 'invented' }] } },
  ];
  for (const [index, invalid] of cases.entries()) {
    const { db, path } = fixture(t); insert(db, { id: 'valid-first', payloads: ['{"id":"valid"}'] }); insert(db, { id: `invalid-${index}`, ...invalid });
    const before = snapshot(db); db.close(); assert.throws(() => openData(path));
    const unchanged = new DatabaseSync(path);
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual(snapshot(unchanged), before); unchanged.close();
  }
});

test('a failure after table replacement rolls back original schema and restores foreign-key enforcement', t => {
  const { db, path } = fixture(t); insert(db, { payloads: ['{"id":"keep"}'] });
  const before = snapshot(db), schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='authoring_conversations'").get().sql; db.close();
  const exec = DatabaseSync.prototype.exec; let restored = false;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('DROP TABLE authoring_conversations;')) throw new Error('injected replacement failure');
    if (sql === 'PRAGMA foreign_keys=ON') restored = this.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;
    return result;
  };
  try { assert.throws(() => openData(path), /injected replacement failure/); } finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(restored, true);
  const unchanged = new DatabaseSync(path);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(unchanged.prepare("SELECT sql FROM sqlite_master WHERE name='authoring_conversations'").get().sql, schema);
  assert.deepEqual(snapshot(unchanged), before); unchanged.close();
});

test('schema 6 enforces owner/run lineage and immutable creation time and dispatch outcomes', t => {
  const { db, path } = fixture(t);
  insert(db, { operations: [{ id: 'op', hash: 'hash', runId: 'run', version: 1 }], state: { createdAt: 1,
    journal: [{ runId: 'run', ordinal: 1, kind: 'provider', reservedMicros: 99 }] } }); db.close();
  const upgraded = openData(path);
  assert.throws(() => upgraded.exec('UPDATE authoring_conversations SET created_at=2'), /immutable/);
  upgraded.exec('UPDATE authoring_conversations SET created_at=created_at');
  for (const sql of ["UPDATE authoring_dispatches SET reserved_micros=0", "UPDATE authoring_dispatches SET outcome='invalid'",
    "INSERT INTO authoring_messages VALUES ('conversation','leo',1,'foreign','{}')",
    "INSERT INTO authoring_operations VALUES ('conversation','leo','foreign','hash','foreign-run',1)",
    "INSERT INTO authoring_dispatches VALUES ('conversation','leo','run',2,'tool','call',0,NULL)",
    "INSERT INTO authoring_dispatches VALUES ('conversation','maya','missing-run',2,'tool','call',0,NULL)"])
    assert.throws(() => upgraded.exec(sql));
  upgraded.exec("UPDATE authoring_dispatches SET outcome='UNKNOWN'");
  assert.throws(() => upgraded.exec("UPDATE authoring_dispatches SET outcome='SUCCESS'"), /immutable/);
  assert.throws(() => upgraded.exec('UPDATE authoring_dispatches SET reserved_micros=0'), /immutable/);
  assert.equal(upgraded.prepare('SELECT reserved_micros FROM authoring_dispatches').get().reserved_micros, 99);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []); upgraded.close();
});
