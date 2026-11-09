import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

const source = readFileSync(new URL('../src/data.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function migration(name) {
  const declaration = `const ${name} = \``;
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `Missing ${name} schema declaration`);
  const end = source.indexOf('`;', start + declaration.length);
  assert.notEqual(end, -1, `Missing ${name} schema terminator`);
  return source.slice(start + declaration.length, end);
}
const addGuard = migration('addTaskCreateGuard');
function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
}
function snapshotQueries(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
    const filter = name === 'extension_selections' ? " WHERE hook_id!='TaskBeforeCreate'" : '';
    return database => database.prepare(`SELECT rowid AS saved_rowid,${columns.join(',')} FROM ${name}${filter} ORDER BY rowid`).all();
  });
}

function schema13Fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'task-guard-upgrade-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    // Build the admitted v13 schema without running the v14 initialization or its guard migration.
    for (const name of ['schema', 'addTaskFields', 'rebuildTaskWorkflow', 'cutoverTaskWorkflow']) db.exec(migration(name));
    db.exec('PRAGMA user_version=13');
    insert(db, 'authoring_budget', { id: 1, reserved_micros: 321 });
    const now = '2026-01-02T03:04:05.678Z';
    for (const owner of ['maya', 'leo', 'sam']) {
      insert(db, 'users', { id: owner, name: owner });
      insert(db, 'projects', { id: owner + '-project', owner_id: owner, name: 'Saved project', created_at: now, updated_at: now });
      for (const hook of ['TaskCompleted', 'TaskCreated']) insert(db, 'extension_selections', {
        owner_id: owner, hook_id: hook, revision_id: null, generation: 13, binding_pins: null,
      });
    }
    const bindings = new Map();
    for (const [owner, generation] of [['maya', 9], ['leo', 9007199254740991]]) {
      const binding = seedTaskEffectBinding(db, owner);
      bindings.set(owner, binding);
      const artifact = JSON.parse(Buffer.from(db.prepare('SELECT artifact FROM extension_authored WHERE revision_id=?').get(binding.revisionId).artifact));
      assert.equal(artifact.format, 'keir-artifact/2');
      assert.ok(artifact.steps.some(step => step.capability === 'tasks.create' && step.version === '2'));
      db.prepare("UPDATE extension_selections SET revision_id=?,generation=?,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
        .run(binding.revisionId, generation, JSON.stringify(binding.pins, null, 2), owner);
    }
    function task(id, title = '  Saved\u0000task λ  ') {
      insert(db, 'tasks', { id, owner_id: 'maya', project_id: 'maya-project', title, notes: ' Original\u0000notes λ ',
        tags: '[ "client", "review" ]', priority: 'high', due_at: '2028-02-29T17:42:37.123Z',
        status: 'completed', created_at: now, updated_at: now, completed_at: now });
    }
    const binding = bindings.get('maya');
    function event(id, state, extra = {}) {
      task(id + '-task');
      const row = { event_id: id, owner_id: 'maya', source_task_id: id + '-task', hook_id: 'TaskCompleted', original_key: randomUUID(),
        item_id: binding.extensionId, revision_id: binding.revisionId, selection_generation: 9,
        input: JSON.stringify({ taskId: id + '-task', occurredAt: now }, null, 2), pins: JSON.stringify(binding.pins, null, 2),
        state, revoked_at: null, outcome: state === 'FINISHED' ? '{ "classification": "COMPLETED" }' : null,
        reconciliation: null, created_at: now, ...extra };
      insert(db, 'task_events', row);
      return row;
    }
    event('pending', 'PENDING');
    const created = event('created', 'FINISHED', { reconciliation: '{ "observedAt": "2026-01-03T00:00:00.000Z" }' });
    const updated = event('updated', 'STARTED');
    const rejected = event('rejected', 'STARTED', { revoked_at: 123 });
    task('created-task-result', 'Saved workflow result');
    for (const [row, capability, version, affected, observation] of [
      [created, 'tasks.create', '2', 'created-task-result', { created: { id: 'created-task-result', projectId: 'maya-project', title: 'Saved workflow result', notes: 'Kept notes', tags: ['client'], priority: 'high', dueAt: null } }],
      [updated, 'tasks.update', '1', updated.source_task_id, { updated: { id: updated.source_task_id, before: { tags: [], priority: 'normal', dueAt: null }, after: { tags: ['client'], priority: 'high', dueAt: null } } }],
      [rejected, 'tasks.create', '2', null, null],
    ]) insert(db, 'task_effect_receipts', {
      owner_id: row.owner_id, capability_id: capability, original_key: row.original_key, capability_version: version,
      payload: Buffer.from(JSON.stringify(capability === 'tasks.update' ? { priority: 'high' } : { projectId: 'maya-project', title: 'Saved workflow result', notes: 'Kept\u0000notes λ' }, null, 2)),
      result: JSON.stringify(affected ? { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: affected } } : { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' }, null, 2),
      effect: affected ? 'CONFIRMED' : 'NONE', affected_task_id: affected, observation: observation ? JSON.stringify(observation, null, 2) : null,
    });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  return { directory, path };
}

test('v13 upgrade retains selected /2 rules, pending events and exact saved bytes without recutover or reseeding', async t => {
  const { directory, path } = schema13Fixture(t);
  const bytes = readFileSync(path);
  await assert.rejects(resetData(directory, true, () => assert.fail('v13 reset attempted a backup')), /Unsupported database version/);
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(directory), ['app.sqlite']);
  const old = new DatabaseSync(path, { readOnly: true });
  const queries = snapshotQueries(old), before = queries.map(query => query(old));
  assert.equal(old.prepare("SELECT count(*) AS n FROM task_events WHERE state='PENDING' AND revoked_at IS NULL").get().n, 1);
  old.close();
  let upgradedBytes;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openData(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
      assert.deepEqual(queries.map(query => query(db)), before);
      assert.deepEqual(db.prepare("SELECT owner_id,revision_id,generation,binding_pins FROM extension_selections WHERE hook_id='TaskBeforeCreate' ORDER BY owner_id").all().map(Object.values),
        ['leo', 'maya', 'sam'].map(owner => [owner, null, 0, null]));
      assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts WHERE guard_details IS NULL').get().n, 3);
      assert.equal(db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    if (attempt === 0) upgradedBytes = readFileSync(path);
    else assert.deepEqual(readFileSync(path), upgradedBytes, 'Opening v14 again must not migrate, reseed or rewrite saved data');
  }
});

test('every v13 guard-migration statement and final version write rolls back atomically', t => {
  const { path } = schema13Fixture(t);
  const original = readFileSync(path), old = new DatabaseSync(path, { readOnly: true });
  const queries = snapshotQueries(old), before = queries.map(query => query(old));
  const schema = db => db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const originalSchema = schema(old);
  old.close();
  const exec = DatabaseSync.prototype.exec;
  // Split only at top-level statement starts, keeping the immutable trigger's body intact.
  const starts = [...addGuard.matchAll(/^ {2}(?:ALTER TABLE|CREATE TABLE|INSERT INTO|DROP TABLE|CREATE TRIGGER)\b/gm)].map(match => match.index);
  const statements = starts.map((start, index) => addGuard.slice(start, starts[index + 1] ?? addGuard.length));
  for (let boundary = 0; boundary <= statements.length; boundary++) {
    let interrupted = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (boundary < statements.length && sql === addGuard) {
        exec.call(this, statements.slice(0, boundary + 1).join(''));
        interrupted = true;
        throw new Error('Guard migration interrupted');
      }
      const result = exec.call(this, sql);
      if (boundary === statements.length && sql === 'PRAGMA user_version=14') {
        interrupted = true;
        throw new Error('Guard migration interrupted');
      }
      return result;
    };
    try { assert.throws(() => openData(path), /Guard migration interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(interrupted, true, `Migration boundary ${boundary} was not reached`);
    const rolledBack = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(rolledBack.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual(schema(rolledBack), originalSchema);
      assert.deepEqual(queries.map(query => query(rolledBack)), before);
    } finally { rolledBack.close(); }
    assert.deepEqual(readFileSync(path), original);
  }
});
