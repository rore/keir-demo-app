import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openData, resetData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

const tables = ['extensions', 'extension_revision_links', 'extension_approvals', 'extension_evidence',
  'extension_history', 'extension_selections', 'extension_authored', 'extension_revisions'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));

test('reset preserves current authored content, approval, selection and history in a verified backup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-lifecycle-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openData(path), lifecycle = createLifecycle(db);
  const { extensionId, revisionId, pins } = seedTaskEffectBinding(db);
  db.prepare("UPDATE extension_selections SET generation=1,revision_id=?,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'").run(revisionId, JSON.stringify(pins));
  lifecycle.disable('maya', { extensionId, generation: 1 }, () => {});
  const before = snapshot(db);
  db.close();
  await assert.rejects(resetData(directory, true, async (source, destination) => {
    await backup(source, destination);
    const copy = new DatabaseSync(destination);
    try { copy.exec("UPDATE extension_selections SET generation=99 WHERE owner_id='maya'"); } finally { copy.close(); }
  }), /Backup differs/);
  let reopened = openData(path);
  assert.deepEqual(snapshot(reopened), before);
  reopened.close();

  const backupPath = await resetData(directory, true), copy = openData(backupPath);
  try {
    assert.deepEqual(snapshot(copy), before);
    assert.equal(copy.prepare("SELECT generation FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get().generation, 2);
  } finally { copy.close(); }
  reopened = openData(path);
  try {
    assert.deepEqual(createLifecycle(reopened).collection('maya').items, []);
    assert.equal(createLifecycle(reopened).collection('maya').selection.revision, null);
    assert.equal(reopened.prepare('SELECT count(*) n FROM tasks').get().n, 9);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { reopened.close(); }
});
