import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData, taskService, taskEffectService, transaction, revokeTaskAdmissions } from '../src/data.mjs';
import { removeTaskEffectSchema, nativeEffectService, seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

const stores = ['task_completion_events', 'task_effect_receipts'];
const effects = nativeEffectService;

function fixture(t, close = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-effect-storage-')), path = join(directory, 'app.sqlite');
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path };
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
    return [name, db.prepare(`SELECT ${columns.join(',')} FROM ${name} ORDER BY rowid`).all()];
  }));
}
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
const jsonBytes = bytes => JSON.stringify({ x: 'é'.repeat((bytes - 8) / 2) });
function integrity(db) {
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}
function populateLegacy(db) {
  const revision = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='maya'").get().id;
  const item = db.prepare('SELECT extension_id FROM extension_revision_links WHERE revision_id=?').get(revision).extension_id;
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revision, 'maya', 'Original', Buffer.from([0, 255, 195, 169]), Buffer.from([255, 0, 1]), '{ "cases": ["original"] }');
  db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run('legacy-proof', 'maya', revision, 'identity', 'suite', '{ "bytes":"\\u0000λ" }', 1);
  db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('maya', revision, 'legacy-proof');
  db.prepare('UPDATE extensions SET draft_revision_id=?,draft_version=8,deleted_at=123 WHERE id=?').run(revision, item);
  db.prepare("UPDATE extension_selections SET generation=17 WHERE owner_id='maya'").run();
  db.prepare("UPDATE tasks SET notes=? WHERE owner_id='maya'").run('original\u0000λ');
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-chat', 'maya', 'legacy-create', 1, 'legacy-run', 'INTERRUPTED', 0, 456, '{ "opaque":"\\u0000λ" }', '[]', '{"messages":[]}', 123);
  db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run('legacy-chat', 'maya', item, 'REVISE', revision, 17);
  db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run('legacy-chat', 'maya', 1, 'legacy-message', '{ "receipt":"original" }');
  db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run('legacy-chat', 'maya', 'legacy-operation', 'original-hash', 'legacy-run', 1);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run('legacy-chat', 'maya', 'legacy-run', 1, 'provider', null, 321, 'UNKNOWN');
  db.exec('UPDATE authoring_budget SET reserved_micros=321');
}
function legacyFixture(t) {
  const f = fixture(t), db = openData(f.path);
  removeTaskEffectSchema(db);
  db.exec('PRAGMA user_version=7');
  populateLegacy(db);
  const before = snapshot(db), beforeSchema = schema(db);
  db.close();
  return { ...f, before, beforeSchema };
}
function insert(db, table, row) {
  return db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
function eventRow(db, changes = {}) {
  const native = taskService(db), project = native.listProjects('maya')[0];
  const task = native.createTask('maya', { projectId: project.id, title: 'Storage source' });
  return { event_id: randomUUID(), owner_id: 'maya', source_task_id: task.id, original_key: randomUUID(), item_id: null,
    revision_id: null, selection_generation: 0, input: JSON.stringify({ taskId: task.id }), pins: null,
    state: 'NO_BINDING', revoked_at: null, outcome: null, reconciliation: null, created_at: '2026-01-01T00:00:00.000Z', ...changes };
}
function receiptRow(event, changes = {}) {
  return { owner_id: event.owner_id, capability_id: 'tasks.create', original_key: event.original_key, capability_version: '1',
    payload: Buffer.from('{"projectId":"original","title":"Original"}'), result: '{"kind":"BUSINESS_REJECTION","code":"PROJECT_NOT_FOUND","effect":"NONE"}',
    effect: 'NONE', created_task_id: null, ...changes };
}
function populatedEffects(db) {
  const native = taskService(db), project = native.listProjects('maya')[0];
  const selected = seedTaskEffectBinding(db);
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=4,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'").run(selected.revisionId, JSON.stringify(selected.pins));
  const source = native.createTask('maya', { projectId: project.id, title: 'Complete this task' });
  native.completeTask('maya', source.id);
  const event = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(source.id), service = effects(db);
  service.claim('maya', event.event_id);
  const key = service.keyFor('maya', event.event_id), payload = { projectId: project.id, title: 'Created once' };
  const result = service.createTaskOnce('maya', key, payload);
  db.exec('UPDATE authoring_budget SET reserved_micros=321');
  return { event, key, payload, createdId: result.value.id, service };
}

test('populated schema 7 upgrades without changing old bytes, selection, history, tombstones or held UNKNOWN spend', t => {
  const { path, before, beforeSchema } = legacyFixture(t);
  let db = openData(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  const after = snapshot(db);
  assert.deepEqual(Object.keys(after), [...Object.keys(before), ...stores].sort());
  for (const [table, rows] of Object.entries(before)) {
    const actual = table === 'extension_selections'
      ? db.prepare("SELECT CAST(owner_id AS BLOB) AS owner_id,CAST(revision_id AS BLOB) AS revision_id,generation FROM extension_selections WHERE hook_id='ClassifyTask' ORDER BY rowid").all()
      : after[table];
    assert.deepEqual(actual, rows, table);
  }
  assert.deepEqual(db.prepare("SELECT owner_id,revision_id,generation,binding_pins FROM extension_selections WHERE hook_id='TaskCompleted' ORDER BY owner_id").all().map(row => ({ ...row })),
    ['leo', 'maya', 'sam'].map(owner_id => ({ owner_id, revision_id: null, generation: 0, binding_pins: null })));
  assert.equal(db.prepare("SELECT count(*) n FROM extension_selections WHERE hook_id='ClassifyTask' AND binding_pins IS NOT NULL").get().n, 0);
  for (const table of stores) assert.deepEqual(after[table], []);
  const oldObjects = new Set(beforeSchema.filter(row => row.name !== 'extension_selections').map(row => row.name));
  assert.deepEqual(schema(db).filter(row => oldObjects.has(row.name)), beforeSchema.filter(row => oldObjects.has(row.name)));
  integrity(db);
  db.close(); db = openData(path);
  assert.deepEqual(snapshot(db), after); integrity(db); db.close();
});

test('schema 8 DDL failure restores original selection table, index set, rows and version; future schema is untouched', t => {
  const { path, before, beforeSchema } = legacyFixture(t), exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('CREATE TABLE task_completion_events')) throw new Error('injected schema 8 failure');
    return result;
  };
  try { assert.throws(() => openData(path), /injected schema 8 failure/); } finally { DatabaseSync.prototype.exec = exec; }
  let db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(schema(db), beforeSchema);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => openData(path), /Unsupported database version/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(schema(db), beforeSchema);
  db.exec('PRAGMA user_version=7'); db.close();
  db = openData(path); integrity(db); db.close();
});

test('schema 8 rejects duplicate event/key, cross-owner lineage and invalid state, byte and integer bounds', t => {
  let db; const { path } = fixture(t, () => db?.close()); db = openData(path);
  const event = eventRow(db); insert(db, stores[0], event);
  assert.throws(() => insert(db, stores[0], { ...event, event_id: randomUUID(), original_key: randomUUID() }), /UNIQUE/);
  assert.throws(() => insert(db, stores[0], eventRow(db, { original_key: event.original_key })), /UNIQUE/);
  const foreign = taskService(db).listTasks('leo', taskService(db).listProjects('leo')[0].id)[0];
  const leoRevision = db.prepare("SELECT revision_id,extension_id FROM extension_revision_links WHERE owner_id='leo' LIMIT 1").get();
  const mayaRevision = db.prepare("SELECT revision_id,extension_id FROM extension_revision_links WHERE owner_id='maya' LIMIT 1").get();
  const invalidEvents = [
    [{ source_task_id: foreign.id }, /FOREIGN KEY/], [{ owner_id: 'missing' }, /FOREIGN KEY/],
    [{ state: 'PENDING', item_id: leoRevision.extension_id, revision_id: leoRevision.revision_id }, /FOREIGN KEY/],
    [{ state: 'INVALID' }, /CHECK/], [{ state: 'FINISHED', outcome: '{}' }, /CHECK/],
    [{ state: 'PENDING' }, /CHECK/], [{ outcome: '{}' }, /CHECK/], [{ original_key: 'x'.repeat(35) }, /CHECK/],
    [{ selection_generation: -1 }, /CHECK/], [{ selection_generation: 9007199254740992 }, /CHECK/], [{ selection_generation: 1.5 }, /INTEGER/],
    [{ revoked_at: -1 }, /CHECK/], [{ input: jsonBytes(4098) }, /CHECK/],
    [{ pins: jsonBytes(32770) }, /CHECK/], [{ reconciliation: jsonBytes(32770) }, /CHECK/],
    [{ state: 'FINISHED', item_id: mayaRevision.extension_id, revision_id: mayaRevision.revision_id, outcome: jsonBytes(131074) }, /CHECK/],
    [{ input: 'invalid JSON' }, /CHECK/], [{ reconciliation: 'invalid JSON' }, /CHECK/],
  ];
  for (const [changes, error] of invalidEvents) assert.throws(() => insert(db, stores[0], eventRow(db, changes)), error);
  const boundary = eventRow(db, { selection_generation: 9007199254740991, input: jsonBytes(4096), pins: jsonBytes(32768), reconciliation: jsonBytes(32768) });
  insert(db, stores[0], boundary);
  insert(db, stores[0], eventRow(db, { state: 'FINISHED', item_id: mayaRevision.extension_id, revision_id: mayaRevision.revision_id, outcome: jsonBytes(131072) }));
  assert.throws(() => insert(db, 'extension_selections', { owner_id: 'maya', hook_id: 'ClassifyTask', revision_id: null, generation: 0 }), /UNIQUE/);
  const selectionChanges = [
    [{ hook_id: 'OtherHook' }, /CHECK/], [{ generation: -1 }, /CHECK/], [{ generation: 9007199254740992 }, /CHECK/],
    [{ revision_id: leoRevision.revision_id }, /FOREIGN KEY/], [{ binding_pins: '{}' }, /CHECK/],
    [{ revision_id: mayaRevision.revision_id, binding_pins: jsonBytes(32770) }, /CHECK/],
  ];
  for (const [changes, error] of selectionChanges) {
    const columns = Object.keys(changes);
    assert.throws(() => db.prepare(`UPDATE extension_selections SET ${columns.map(column => `${column}=?`).join(',')} WHERE owner_id='maya' AND hook_id='TaskCompleted'`).run(...Object.values(changes)), error);
  }
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=?,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'")
    .run(mayaRevision.revision_id, 9007199254740991, jsonBytes(32768));
  const receiptEvent = eventRow(db); insert(db, stores[0], receiptEvent);
  const invalidReceipts = [
    [{ owner_id: 'leo' }, /FOREIGN KEY/], [{ original_key: randomUUID() }, /FOREIGN KEY/],
    [{ capability_id: 'tasks.delete' }, /CHECK/], [{ capability_version: '2' }, /CHECK/],
    [{ payload: Buffer.alloc(4097) }, /CHECK/], [{ payload: 'text' }, /BLOB/], [{ result: jsonBytes(4098) }, /CHECK/], [{ result: 'invalid JSON' }, /CHECK/],
    [{ effect: 'UNKNOWN' }, /CHECK/], [{ effect: 'CONFIRMED' }, /CHECK/],
    [{ effect: 'CONFIRMED', created_task_id: foreign.id }, /FOREIGN KEY/],
  ];
  for (const [changes, error] of invalidReceipts) assert.throws(() => insert(db, stores[1], receiptRow(receiptEvent, changes)), error);
  insert(db, stores[1], receiptRow(receiptEvent, { payload: Buffer.alloc(4096), result: jsonBytes(4096) }));
  assert.throws(() => insert(db, stores[1], receiptRow(receiptEvent)), /UNIQUE/);
  const before = snapshot(db);
  assert.throws(() => db.prepare('DELETE FROM tasks WHERE id=?').run(event.source_task_id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('DELETE FROM task_completion_events WHERE event_id=?').run(receiptEvent.event_id), /FOREIGN KEY/);
  assert.deepEqual(snapshot(db), before); integrity(db);
});

test('stored event identity, permanent revocation, settled outcome and receipts cannot be rewritten', t => {
  let db; const { path } = fixture(t, () => db?.close()); db = openData(path);
  const { event, service } = populatedEffects(db);
  const changes = { event_id: randomUUID(), owner_id: 'leo', source_task_id: randomUUID(), original_key: randomUUID(),
    item_id: randomUUID(), revision_id: randomUUID(), selection_generation: 99, input: '{}', pins: '{}', created_at: 'changed', state: 'PENDING' };
  const before = snapshot(db);
  for (const [column, value] of Object.entries(changes)) assert.throws(() => db.prepare(`UPDATE task_completion_events SET ${column}=? WHERE event_id=?`).run(value, event.event_id), /immutable/);
  for (const column of ['owner_id', 'capability_id', 'original_key', 'capability_version', 'payload', 'result', 'effect', 'created_task_id'])
    assert.throws(() => db.prepare(`UPDATE task_effect_receipts SET ${column}=${column}`).run(), /immutable/);
  assert.deepEqual(snapshot(db), before);
  db.prepare('UPDATE task_completion_events SET revoked_at=123 WHERE event_id=?').run(event.event_id);
  for (const value of [null, 124]) assert.throws(() => db.prepare('UPDATE task_completion_events SET revoked_at=? WHERE event_id=?').run(value, event.event_id), /immutable/);
  service.finish('maya', event.event_id, { status: 'CREATED' });
  assert.throws(() => db.prepare("UPDATE task_completion_events SET outcome='{}' WHERE event_id=?").run(event.event_id), /immutable/);
  assert.throws(() => db.prepare("UPDATE task_completion_events SET state='STARTED' WHERE event_id=?").run(event.event_id), /immutable/);
  integrity(db);
});

test('cloned databases with identical event and original key cannot authenticate each other’s native key', async t => {
  let db, copy;
  const { path, directory } = fixture(t, () => { db?.close(); copy?.close(); });
  db = openData(path);
  const { event, key, payload } = populatedEffects(db), clonePath = join(directory, 'clone.sqlite');
  await backup(db, clonePath);
  copy = openData(clonePath);
  const service = taskEffectService(copy), saved = service.status('maya', event.event_id);
  assert.equal(saved.originalKey, key.value);
  const context = { requestKey: key, event: { id: saved.eventId, source: saved.sourceTaskId }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
  const before = snapshot(copy);
  assert.throws(() => service.contextFor('maya', context), { code: 'HOST_KEY_INVALID' });
  assert.throws(() => service.createTaskOnce('maya', key, payload, context), { code: 'HOST_KEY_INVALID' });
  assert.deepEqual(snapshot(copy), before);
  assert.deepEqual(service.createTaskOnce('maya', service.keyFor('maya', saved.eventId), payload), saved.receipt, 'Authenticated historical receipt is read-only');
});

test('failed native revocation is atomic; successful revocation survives reopen without erasing settled receipts', t => {
  let db;
  const { path } = fixture(t, () => db?.close()); db = openData(path);
  const { event, service } = populatedEffects(db);
  service.finish('maya', event.event_id, { classification: 'COMPLETED', effects: [{ state: 'CONFIRMED' }] });
  const settled = service.status('maya', event.event_id);
  const task = taskService(db).createTask('maya', { projectId: taskService(db).listProjects('maya')[0].id, title: 'Pending revoke' });
  taskService(db).completeTask('maya', task.id);
  const before = snapshot(db);
  db.exec("CREATE TEMP TRIGGER fail_revocation BEFORE UPDATE OF revoked_at ON task_completion_events BEGIN SELECT RAISE(ABORT,'revocation blocked'); END");
  assert.throws(() => transaction(db, () => revokeTaskAdmissions(db, 'maya', event.item_id)), /revocation blocked/);
  assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER fail_revocation');
  transaction(db, () => revokeTaskAdmissions(db, 'maya', event.item_id));
  db.close(); db = openData(path);
  const reopened = effects(db), pending = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(task.id);
  assert.notEqual(pending.revoked_at, null); assert.equal(pending.state, 'PENDING');
  assert.throws(() => reopened.claim('maya', pending.event_id), { code: 'AUTHORITY_DENIED' });
  assert.deepEqual(reopened.status('maya', event.event_id), settled);
  assert.equal(db.prepare("SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get().revision_id, null);
});

test('reset verifies both new stores, rolls failed reseeding back and clears keys only with their tasks after a verified backup', async t => {
  const { path, directory } = fixture(t); let db = openData(path);
  const { event, key, payload, createdId } = populatedEffects(db), before = snapshot(db); db.close();
  for (const corrupt of ['DELETE FROM task_effect_receipts', `UPDATE task_completion_events SET reconciliation='{"tampered":true}'`]) {
    await assert.rejects(resetData(directory, true, async (source, destination) => {
      await backup(source, destination);
      const copy = new DatabaseSync(destination); copy.exec(corrupt); copy.close();
    }), /Backup differs/);
    db = openData(path); assert.deepEqual(snapshot(db), before); integrity(db); db.close();
  }
  db = openData(path);
  db.exec("CREATE TRIGGER fail_effect_reset BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT,'seed blocked'); END"); db.close();
  await assert.rejects(resetData(directory, true), /seed blocked/);
  db = openData(path); assert.deepEqual(snapshot(db), before); integrity(db);
  db.exec('DROP TRIGGER fail_effect_reset'); db.close();
  const backupPath = await resetData(directory, true);
  const copy = new DatabaseSync(backupPath, { readOnly: true }); assert.deepEqual(snapshot(copy), before); copy.close();
  db = openData(path);
  for (const table of stores) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 9);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE id IN (?,?)').get(event.source_task_id, createdId).n, 0);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 321);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_selections WHERE hook_id='TaskCompleted' AND revision_id IS NULL AND generation=0 AND binding_pins IS NULL").get().n, 3);
  const current = effects(db);
  assert.throws(() => current.keyFor('maya', event.event_id), error => error.status === 404);
  assert.throws(() => current.createTaskOnce('maya', key, payload), error => error.code === 'HOST_KEY_INVALID');
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 9);
  integrity(db); db.close();
});
