import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { openData, taskEffectService } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';

const stageA = gunzipSync(readFileSync(new URL('./fixtures/daymark-shipped-v12.sqlite.gz', import.meta.url)));
function disposable(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-workflow-cutover-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  writeFileSync(path, stageA);
  return path;
}
function comparison(source) {
  return source.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const columns = source.prepare('PRAGMA table_info(' + name + ')').all();
    const sql = columns.map(({ name: field, type }) => type === 'TEXT' ? 'CAST(' + field + ' AS BLOB) AS ' + field : field).join(',');
    return (db, after = false) => db.prepare('SELECT rowid AS saved_rowid,' + sql + ' FROM '
      + (after && name === 'extension_selections' ? 'legacy_extension_selections' : name) + ' ORDER BY rowid').all();
  });
}
test('Stage A cutover preserves old rows, historical proof, and the definitive receipt', t => {
  const path = disposable(t), old = new DatabaseSync(path, { readOnly: true });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 12);
  const queries = comparison(old), prior = queries.map(query => query(old));
  const selections = old.prepare('SELECT * FROM extension_selections ORDER BY rowid').all();
  const selected = selections.find(row => row.revision_id), identity = JSON.parse(selected.binding_pins);
  const { extension_id: extensionId } = old.prepare('SELECT extension_id FROM extension_revision_links WHERE revision_id=?').get(selected.revision_id);
  const legacyArtifact = old.prepare('SELECT artifact FROM extension_authored WHERE revision_id=?').get(selected.revision_id).artifact;
  old.close();

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openData(path), lifecycle = createLifecycle(db);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual(queries.map(query => query(db, true)), prior);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const current = db.prepare('SELECT * FROM extension_selections ORDER BY rowid').all();
      assert.deepEqual(current, selections.map(row => Object.assign(Object.create(null), row,
        { revision_id: null, binding_pins: null, generation: row.generation + 1 })));
      const item = lifecycle.state(selected.owner_id, extensionId);
      assert.equal(item.retired, true);
      assert.equal(item.legacySelection.eligible, false);
      assert.equal(item.legacySelection.revision.id, selected.revision_id);
      assert.equal(item.selection.revision, null);
      const source = lifecycle.source(selected.owner_id, selected.revision_id, extensionId);
      assert.deepEqual(Buffer.from(source.artifact), Buffer.from(legacyArtifact));
      const proof = lifecycle.evidence(selected.owner_id, identity.approvedEvidenceId, extensionId);
      assert.equal(proof.historical, true);
      assert.equal(proof.passed, true);
      assert.throws(() => lifecycle.execution(selected.owner_id, selected.revision_id, extensionId), { status: 410 });
      const effect = taskEffectService(db);
      const receipts = db.prepare('SELECT * FROM task_effect_receipts ORDER BY rowid').all();
      assert.deepEqual(receipts.map(row => row.effect), ['CONFIRMED', 'CONFIRMED', 'NONE']);
      for (const saved of receipts) {
        const event = db.prepare('SELECT event_id,source_task_id FROM task_events WHERE owner_id=? AND original_key=?').get(saved.owner_id, saved.original_key);
        const key = effect.keyFor(saved.owner_id, event.event_id), invocation = {
          requestKey: key, event: { id: event.event_id, source: event.source_task_id }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 },
        };
        assert.deepEqual(effect.createTaskOnce(saved.owner_id, key, JSON.parse(Buffer.from(saved.payload)), invocation), JSON.parse(saved.result));
        assert.equal(effect.updateTaskOnce(saved.owner_id, key, { priority: 'high' }, invocation).code, 'KEY_PAYLOAD_MISMATCH');
      }
      assert.deepEqual(queries.map(query => query(db, true)), prior);
    } finally { db.close(); }
  }
});

test('cutover rechecks pending work, preserves revoked rows and rolls back after a version write', async t => {
  const path = disposable(t);
  let old = new DatabaseSync(path);
  const selected = old.prepare('SELECT * FROM extension_selections WHERE revision_id IS NOT NULL').get();
  assert.equal(old.prepare("SELECT count(*) AS n FROM task_events WHERE state='PENDING'").get().n, 0);
  const task = old.prepare("SELECT id FROM tasks WHERE owner_id=? AND status='open' AND NOT EXISTS(SELECT 1 FROM task_events WHERE source_task_id=tasks.id) LIMIT 1").get(selected.owner_id);
  const { extension_id: item } = old.prepare('SELECT extension_id FROM extension_revision_links WHERE revision_id=?').get(selected.revision_id);
  const insert = old.prepare("INSERT INTO task_events(event_id,owner_id,source_task_id,hook_id,original_key,item_id,revision_id,selection_generation,input,pins,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',?)");
  const exec = DatabaseSync.prototype.exec;
  let blocked;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'BEGIN IMMEDIATE' && blocked === undefined) {
      insert.run(randomUUID(), selected.owner_id, task.id, selected.hook_id, randomUUID(), item, selected.revision_id, selected.generation,
        JSON.stringify({ taskId: task.id }), selected.binding_pins, '2026-11-06T00:00:00.000Z');
      blocked = readFileSync(path);
    }
    return exec.call(this, sql);
  };
  try { assert.throws(() => openData(path), /unresolved pending task events/); }
  finally { DatabaseSync.prototype.exec = exec; old.close(); }
  assert.ok(blocked);
  assert.deepEqual(readFileSync(path), blocked);
  old = new DatabaseSync(path);
  old.exec("UPDATE task_events SET revoked_at=1 WHERE state='PENDING'");
  const revoked = old.prepare("SELECT * FROM task_events WHERE state='PENDING'").get();
  old.close();
  const upgraded = openData(path), dispatcher = createTaskDispatcher({ db: upgraded, lifecycle: createLifecycle(upgraded) });
  try {
    assert.deepEqual(upgraded.prepare('SELECT * FROM task_events WHERE event_id=?').get(revoked.event_id), revoked);
    assert.equal(dispatcher.status(revoked.owner_id, revoked.source_task_id, revoked.hook_id).revoked, true);
    await dispatcher.wake();
    assert.deepEqual(upgraded.prepare('SELECT * FROM task_events WHERE event_id=?').get(revoked.event_id), revoked);
  } finally { await dispatcher.close(); upgraded.close(); }

  const reference = new DatabaseSync(disposable(t), { readOnly: true });
  try {
    const before = comparison(reference), schema = db => db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    for (const boundary of ['UPDATE extension_selections', 'ALTER TABLE task_effect_receipts', 'INSERT INTO task_effect_receipts',
      'DROP TABLE previous_workflow_receipts', 'PRAGMA user_version=13']) {
      writeFileSync(path, stageA);
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === boundary) {
          exec.call(this, sql);
          throw new Error('Interrupted after version write');
        }
        const offset = sql.includes('CREATE TABLE legacy_extension_selections') ? sql.indexOf(boundary) : -1;
        if (offset !== -1) {
          exec.call(this, sql.slice(0, offset));
          throw new Error('Interrupted during cutover');
        }
        return exec.call(this, sql);
      };
      try { assert.throws(() => openData(path), /Interrupted/); }
      finally { DatabaseSync.prototype.exec = exec; }
      old = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(old.prepare('PRAGMA user_version').get().user_version, 12);
        assert.deepEqual(schema(old), schema(reference));
        for (const read of before) assert.deepEqual(read(old), read(reference));
      } finally { old.close(); }
    }
  } finally { reference.close(); }
});
