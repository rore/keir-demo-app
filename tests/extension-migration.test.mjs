import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openData } from '../src/data.mjs';
import { createLegacyV4 } from './fixtures/legacy-v4.mjs';
import { legacySelections } from './fixtures/task-effect-schema.mjs';

const preservedTables = ['users', 'projects', 'tasks', 'extension_revisions', 'extension_selections',
  'extension_evidence', 'extension_approvals', 'extension_history', 'extension_authored',
  'authoring_budget', 'authoring_conversations'];
const snapshot = (db, tables) => Object.fromEntries(tables.map(table =>
  [table, table === 'extension_selections' ? legacySelections(db) : db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

function fixture(t, { missingCreatedAt = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-extension-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  const db = createLegacyV4(path);
  // Supply the persisted original clock in this caller's rows; frozen V4 DDL stays unchanged.
  for (const [index, row] of db.prepare('SELECT id,state FROM authoring_conversations ORDER BY rowid').all().entries()) {
    if (!missingCreatedAt || index !== 0) db.prepare('UPDATE authoring_conversations SET state=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(row.state), createdAt: 90 + index }), row.id);
  }
  return { path, db };
}

test('V4 migration preserves immutable rows and budgets, links only proven legacy lineage, and is idempotent', t => {
  const { path, db } = fixture(t);
  const before = snapshot(db, preservedTables);
  const selections = before.extension_selections;
  db.close();

  let upgraded = openData(path);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 9);
  const after = snapshot(upgraded, preservedTables);
  for (const table of preservedTables.filter(table => table !== 'authoring_conversations')) {
    if (table === 'tasks') assert.deepEqual(after.tasks.map(row => ({ ...row })), before.tasks.map(row => ({ ...row, tags: '[]' })));
    else assert.deepEqual(after[table], before[table], table);
  }
  assert.deepEqual(after.authoring_conversations.map(row => ({ ...row })), before.authoring_conversations.map(row =>
    ({ ...row, created_at: JSON.parse(row.state).createdAt })), 'Original header values and their recorded creation clocks survive exactly.');
  assert.equal(upgraded.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='extension_states'").get().n, 0);
  const entities = upgraded.prepare('SELECT id,owner_id,hook_id,name,draft_version,draft_revision_id FROM extensions ORDER BY owner_id').all();
  assert.equal(entities.length, 2);
  assert.deepEqual(entities.map(({ owner_id }) => owner_id), ['owner-a', 'owner-b']);
  assert.ok(entities.every(({ name }) => name.trim().length > 0));
  assert.deepEqual(entities.map(({ draft_revision_id, draft_version }) => [draft_revision_id, draft_version]), [['rev-a-draft', 7], ['rev-b-active', 2]]);
  assert.ok(entities.every(({ hook_id }) => hook_id === 'ClassifyTask'));
  assert.deepEqual(upgraded.prepare('SELECT revision_id,owner_id FROM extension_revision_links ORDER BY revision_id').all().map(row => ({ ...row })), [
    { revision_id: 'rev-a-active', owner_id: 'owner-a' },
    { revision_id: 'rev-a-draft', owner_id: 'owner-a' },
    { revision_id: 'rev-b-active', owner_id: 'owner-b' },
  ]);

  const links = upgraded.prepare('SELECT conversation_id,owner_id,extension_id,purpose,base_revision_id,base_generation FROM extension_conversation_links ORDER BY conversation_id').all();
  assert.equal(links.length, 2);
  assert.deepEqual(links.map(row => [row.conversation_id, row.owner_id, row.purpose, row.base_revision_id, row.base_generation]), [
    ['chat-a-revise-handle', 'owner-a', 'REVISE', 'rev-a-draft', null],
    ['chat-a-revise-review', 'owner-a', 'REVISE', 'rev-a-draft', null],
  ]);
  for (const id of ['chat-a-active', 'chat-a-null-history', 'chat-a-ambiguous', 'chat-b-one', 'chat-b-two', 'chat-empty']) {
    assert.equal(upgraded.prepare('SELECT count(*) n FROM extension_conversation_links WHERE conversation_id=?').get(id).n, 0, `${id} stays owner-readable without guessed extension binding`);
  }
  assert.equal(upgraded.prepare('SELECT count(*) n FROM extensions WHERE owner_id=?').get('owner-empty').n, 0);
  assert.deepEqual(upgraded.prepare('SELECT id,owner_id,revision_id,generation,operation FROM extension_history ORDER BY id').all().map(row => ({ ...row }))
    .filter(row => row.revision_id === null), [{ id: 3, owner_id: 'owner-a', revision_id: null, generation: 10, operation: 'disable' }]);
  assert.deepEqual(upgraded.prepare("SELECT owner_id,revision_id,generation FROM extension_selections WHERE hook_id='ClassifyTask' ORDER BY owner_id").all().map(row => ({ ...row })), selections.map(({ owner_id, revision_id, generation }) => ({ owner_id, revision_id, generation })));
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);

  const extensionA = entities.find(row => row.owner_id === 'owner-a').id;
  const extensionB = entities.find(row => row.owner_id === 'owner-b').id;
  assert.throws(() => upgraded.prepare('INSERT INTO extension_revision_links(revision_id,owner_id,extension_id) VALUES (?,?,?)').run('rev-a-active', 'owner-b', extensionB));
  assert.throws(() => upgraded.prepare(`INSERT INTO extension_conversation_links
    (conversation_id,owner_id,extension_id,purpose,base_revision_id,base_generation) VALUES (?,?,?,?,?,?)`)
    .run('chat-a-ambiguous', 'owner-a', extensionB, 'REVISE', null, null));
  assert.ok(extensionA);

  const allTables = [...preservedTables, 'extensions', 'extension_revision_links', 'extension_conversation_links', 'authoring_messages', 'authoring_operations', 'authoring_dispatches'];
  const afterFirstOpen = snapshot(upgraded, allTables);
  upgraded.close();
  upgraded = openData(path);
  assert.deepEqual(snapshot(upgraded, allTables), afterFirstOpen);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  upgraded.close();
});

test('missing original creation time fails V5-to-V6 safely without inventing a timestamp or losing prior rows', t => {
  const { path, db } = fixture(t, { missingCreatedAt: true });
  const before = snapshot(db, preservedTables); db.close();
  assert.throws(() => openData(path), /Invalid legacy authoring history/);
  let unchanged = new DatabaseSync(path);
  assert.deepEqual(snapshot(unchanged, preservedTables), before);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 5, 'The prior V4-to-V5 migration completed before atomic V5-to-V6 failed.');
  const tables = [...preservedTables, 'extensions', 'extension_revision_links', 'extension_conversation_links'];
  const v5 = snapshot(unchanged, tables);
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('authoring_messages','authoring_operations','authoring_dispatches','authoring_conversations_v6')").get().n, 0);
  assert.equal(unchanged.prepare('PRAGMA table_info(authoring_conversations)').all().some(row => row.name === 'created_at'), false);
  unchanged.close();
  assert.throws(() => openData(path), /Invalid legacy authoring history/);
  unchanged = new DatabaseSync(path);
  assert.deepEqual(snapshot(unchanged, tables), v5);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 5); unchanged.close();
});

test('invalid future version fails without resetting legacy rows', t => {
  const { path, db } = fixture(t);
  const before = snapshot(db, preservedTables);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => openData(path), /Unsupported database version/);
  const unchanged = new DatabaseSync(path);
  assert.deepEqual(snapshot(unchanged, preservedTables), before);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 99);
  unchanged.close();
});

test('V5 DDL failure rolls the migration back with legacy content and version intact', t => {
  const { path, db } = fixture(t);
  const before = snapshot(db, preservedTables);
  db.exec("CREATE TABLE extension_conversation_links(conflict TEXT); PRAGMA user_version=4");
  db.close();
  assert.throws(() => openData(path), /already exists/);
  const unchanged = new DatabaseSync(path);
  assert.deepEqual(snapshot(unchanged, preservedTables), before);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='extensions'").get().n, 0);
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='extension_conversation_links'").get().n, 1);
  unchanged.close();
});
