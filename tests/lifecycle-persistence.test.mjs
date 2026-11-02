import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';

const tables = ['extension_approvals','extension_evidence','extension_history','extension_selections','extension_states','extension_revisions'];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-lifecycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'app.sqlite') };
}
function legacy(path) {
  const db = openData(path);
  const original = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  for (const table of tables) db.exec(`DROP TABLE ${table}`);
  db.exec('PRAGMA user_version=1');
  db.close(); return original;
}

test('populated v1 migrates once, preserving every native row with explicit operator provenance and no fake approval', t => {
  const { path } = fixture(t), original = legacy(path);
  let db = openData(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), original);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  let lifecycle = createLifecycle(db);
  assert.equal(lifecycle.state('maya').selection.revision.provenance, 'operator');
  assert.equal(lifecycle.state('leo').selection.revision.provenance, 'operator');
  assert.equal(lifecycle.state('sam').selection.revision, null);
  const target = lifecycle.state('maya').selection.revision.id;
  lifecycle.disable('maya', { generation: 1 }, () => {});
  db.close(); db = openData(path); lifecycle = createLifecycle(db);
  assert.equal(lifecycle.state('maya').selection.revision, null);
  assert.equal(lifecycle.state('maya').selection.generation, 2);
  lifecycle.rollback('maya', { revisionId: target, generation: 2 }, () => {});
  db.close(); db = openData(path);
  assert.equal(createLifecycle(db).state('maya').selection.revision.id, target);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), original);
  db.close();
});

test('failed migration rolls back all new DDL and native rows; unsupported version is never reset', t => {
  const { path } = fixture(t), original = legacy(path);
  let db = new DatabaseSync(path);
  db.exec('CREATE TABLE extension_states(conflict TEXT)'); db.close();
  assert.throws(() => openData(path), /already exists/);
  db = new DatabaseSync(path);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), original);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='extension_revisions'").get().n, 0);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => openData(path), /Unsupported database version/);
});

test('reset verifies and backs up lifecycle rows before deleting them; corrupted backup leaves original untouched', async t => {
  const { path, directory } = fixture(t);
  const db = openData(path), lifecycle = createLifecycle(db);
  lifecycle.disable('maya', { generation: 1 }, () => {});
  db.close();
  await assert.rejects(resetData(directory, true, async (source, destination) => {
    await backup(source, destination);
    const copy = new DatabaseSync(destination); copy.exec("UPDATE extension_selections SET generation=99 WHERE owner_id='maya'"); copy.close();
  }), /Backup differs/);
  let reopened = openData(path);
  assert.equal(createLifecycle(reopened).state('maya').selection.revision, null); reopened.close();
  const backupPath = await resetData(directory, true);
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(copy.prepare("SELECT generation FROM extension_selections WHERE owner_id='maya'").get().generation, 2); copy.close();
  reopened = openData(path);
  assert.equal(createLifecycle(reopened).state('maya').selection.revision.provenance, 'operator');
  assert.equal(reopened.prepare('SELECT count(*) n FROM tasks').get().n, 9);
  assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0); reopened.close();
});
