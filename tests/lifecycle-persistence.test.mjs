import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { legacySelections, removeTaskEffectSchema } from './fixtures/task-effect-schema.mjs';

const tables = ['extension_approvals','extension_evidence','extension_history','extension_selections','extension_states','extension_authored','extension_revisions'];
function itemId(api, owner) {
  const items = api.collection(owner).items;
  assert.equal(items.length, 1, 'Fixture has one explicitly scoped saved extension.');
  return items[0].extension.id;
}
function removeItemSchema(db) {
  removeTaskEffectSchema(db);
  db.exec('UPDATE extensions SET draft_revision_id=NULL; DROP TABLE extension_conversation_links; DROP TABLE extension_revision_links; DROP TABLE extensions');
}
function removeAuthoringSchema(db) {
  for (const table of ['authoring_dispatches', 'authoring_messages', 'authoring_operations', 'authoring_conversations', 'authoring_budget']) db.exec(`DROP TABLE ${table}`);
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-lifecycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'app.sqlite') };
}
function legacy(path) {
  const db = openData(path);
  const original = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  removeItemSchema(db);
  removeAuthoringSchema(db);
  for (const table of tables.filter(table => table !== 'extension_states')) db.exec(`DROP TABLE ${table}`);
  db.exec('PRAGMA user_version=1');
  db.close(); return original;
}

test('populated v1 migrates once, preserving every native row with explicit operator provenance and no fake approval', t => {
  const { path } = fixture(t), original = legacy(path);
  let db = openData(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), original);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  let lifecycle = createLifecycle(db);
  assert.equal(lifecycle.collection('maya').selection.revision.provenance, 'operator');
  assert.equal(lifecycle.collection('leo').selection.revision.provenance, 'operator');
  assert.equal(lifecycle.collection('sam').selection.revision, null);
  const extensionId = itemId(lifecycle, 'maya');
  const target = lifecycle.state('maya', extensionId).selection.revision.id;
  lifecycle.disable('maya', { extensionId, generation: 1 }, () => {});
  db.close(); db = openData(path); lifecycle = createLifecycle(db);
  assert.equal(lifecycle.state('maya', extensionId).selection.revision, null);
  assert.equal(lifecycle.state('maya', extensionId).selection.generation, 2);
  lifecycle.rollback('maya', { extensionId, revisionId: target, generation: 2 }, () => {});
  db.close(); db = openData(path);
  assert.equal(createLifecycle(db).state('maya', extensionId).selection.revision.id, target);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), original);
  db.close();
});

test('populated v2 upgrades and reopens without changing native or lifecycle rows', async t => {
  const { path } = fixture(t), db = openData(path);
  const api = createLifecycle(db);
  let state = api.load('maya', { extensionId: itemId(api, 'maya'), templateId: 'attention', draftVersion: 0 }, () => {});
  const input = { extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion };
  state = await api.simulate('maya', input, () => {});
  api.approve('maya', { ...input, evidenceId: state.evidence.id }, () => {});
  api.activate('maya', { ...input, generation: state.selection.generation }, () => {});
  api.disable('leo', { extensionId: itemId(api, 'leo'), generation: api.collection('leo').selection.generation }, () => {});
  const heads = db.prepare('SELECT owner_id,draft_version,draft_revision_id FROM extensions').all();
  removeItemSchema(db);
  db.exec(`CREATE TABLE extension_states(owner_id TEXT PRIMARY KEY REFERENCES users(id), draft_version INTEGER NOT NULL CHECK(draft_version>=0),
    draft_id TEXT, FOREIGN KEY(draft_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT`);
  for (const owner of db.prepare('SELECT id FROM users').all()) {
    const head = heads.find(row => row.owner_id === owner.id);
    db.prepare('INSERT INTO extension_states VALUES (?,?,?)').run(owner.id, head?.draft_version ?? 0, head?.draft_revision_id ?? null);
  }
  removeAuthoringSchema(db);
  db.exec('DROP TABLE extension_authored; PRAGMA user_version=2');
  const native = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const lifecycle = Object.fromEntries(tables.filter(table => table !== 'extension_authored').map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();

  let upgraded = openData(path);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 8);
  assert.deepEqual(upgraded.prepare('SELECT * FROM tasks ORDER BY id').all(), native);
  for (const [table, rows] of Object.entries(lifecycle)) {
    if (table === 'extension_states') {
      for (const row of rows) {
        const head = upgraded.prepare('SELECT draft_version,draft_revision_id FROM extensions WHERE owner_id=?').get(row.owner_id);
        assert.equal(head?.draft_version ?? 0, row.draft_version);
        assert.equal(head?.draft_revision_id ?? null, row.draft_id);
      }
    } else assert.deepEqual(table === 'extension_selections' ? legacySelections(upgraded) : upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
  }
  upgraded.close();
  upgraded = openData(path);
  assert.deepEqual(upgraded.prepare('SELECT * FROM tasks ORDER BY id').all(), native);
  for (const [table, rows] of Object.entries(lifecycle).filter(([table]) => table !== 'extension_states')) assert.deepEqual(table === 'extension_selections' ? legacySelections(upgraded) : upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
  assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(upgraded.prepare('SELECT count(*) n FROM extension_authored').get().n, 0);
  upgraded.close();
});

test('v2 migration rolls back when the authored table already exists', t => {
  const { path } = fixture(t), db = openData(path);
  removeTaskEffectSchema(db);
  removeAuthoringSchema(db);
  db.exec(`DROP TABLE extension_authored; CREATE TABLE extension_authored(conflict TEXT); PRAGMA user_version=2`);
  db.close();
  assert.throws(() => openData(path), /already exists/);
  const unchanged = new DatabaseSync(path);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE name='extension_authored'").get().n, 1);
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE name='extension_revisions'").get().n, 1);
  assert.equal(unchanged.prepare('SELECT count(*) n FROM tasks').get().n, 9);
  unchanged.close();
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
  lifecycle.disable('maya', { extensionId: itemId(lifecycle, 'maya'), generation: 1 }, () => {});
  const revisionId = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='maya'").get().id;
  const source = Buffer.from('customer source');
  const artifact = Buffer.from('compiled artifact');
  db.prepare('INSERT INTO extension_authored VALUES (?, ?, ?, ?, ?, ?)').run(revisionId, 'maya', 'Authored item', source, artifact, null);
  db.close();
  await assert.rejects(resetData(directory, true, async (source, destination) => {
    await backup(source, destination);
    const copy = new DatabaseSync(destination); copy.exec("UPDATE extension_selections SET generation=99 WHERE owner_id='maya' AND hook_id='ClassifyTask'"); copy.close();
  }), /Backup differs/);
  let reopened = openData(path);
  assert.equal(createLifecycle(reopened).collection('maya').selection.revision, null); reopened.close();
  const backupPath = await resetData(directory, true);
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(copy.prepare("SELECT generation FROM extension_selections WHERE owner_id='maya' AND hook_id='ClassifyTask'").get().generation, 2); copy.close();
  const verified = new DatabaseSync(backupPath, { readOnly: true });
  const backedUp = verified.prepare('SELECT owner_id, label, source, artifact, suite FROM extension_authored WHERE revision_id=?').get(revisionId);
  assert.equal(backedUp.owner_id, 'maya');
  assert.equal(backedUp.label, 'Authored item');
  assert.deepEqual(Buffer.from(backedUp.source), source);
  assert.deepEqual(Buffer.from(backedUp.artifact), artifact);
  assert.equal(backedUp.suite, null);
  verified.close();
  reopened = openData(path);
  assert.equal(createLifecycle(reopened).collection('maya').selection.revision.provenance, 'operator');
  assert.equal(reopened.prepare('SELECT count(*) n FROM tasks').get().n, 9);
  assert.equal(reopened.prepare('SELECT count(*) n FROM extension_authored').get().n, 0);
  assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0); reopened.close();
});
