import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openData, resetData } from '../src/data.mjs';
import { addTeamProjects, addTeamCapabilities, teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime, installTeamRevision } from '../src/team-runtime.mjs';
import { compileTeamFixture } from '../scripts/team-native-fixture.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { restoreSavedCore } from './fixtures/saved-core-0.3.0.mjs';

let assets;
before(async () => { assets = await compileTeamFixture(); });
const inventory = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
  const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
  return `SELECT rowid,${columns.join(',')} FROM ${name} ORDER BY rowid`;
});
async function populated15(t) {
  const directory = mkdtempSync(join(tmpdir(), 'team-capability-upgrade-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  const source = readFileSync(new URL('../src/data.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['schema', 'addTaskFields', 'rebuildTaskWorkflow', 'cutoverTaskWorkflow', 'addTaskCreateGuard']) {
    const declaration = `const ${name} = \``, start = source.indexOf(declaration);
    assert.notEqual(start, -1);
    db.exec(source.slice(start + declaration.length, source.indexOf('`;', start + declaration.length)));
  }
  db.exec(addTeamProjects);
  for (const id of ['maya', 'leo', 'sam']) {
    db.prepare('INSERT INTO users VALUES (?,?)').run(id, id);
    for (const hook of ['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate'])
      db.prepare('INSERT INTO extension_selections(owner_id,hook_id,generation) VALUES (?,?,0)').run(id, hook);
  }
  db.exec('INSERT INTO authoring_budget VALUES (1,321); PRAGMA user_version=15');
  restoreSavedCore(db, JSON.parse(readFileSync(new URL('./fixtures/saved-core-0.4.0.json', import.meta.url))));
  const projectId = randomUUID(), empty = randomUUID(), now = '2026-01-02T03:04:05.678Z';
  for (const id of [projectId, empty]) {
    db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,'maya','Saved Team',?,?,'TEAM')").run(id, now, now);
    db.prepare("INSERT INTO project_members VALUES (?,'maya','ADMIN')").run(id);
    db.prepare("INSERT INTO project_members VALUES (?,'leo','MEMBER')").run(id);
    db.prepare('INSERT INTO team_selections(project_id) VALUES (?)').run(id);
  }
  installTeamRevision(db, 'maya', projectId, 'saved-manual', assets.first);
  teamProjectService(db).setSelection('maya', projectId, 'saved-manual');
  // The current create seam reads the selection generation added after v15.
  // Seed the original admission, then run its real pinned effect on v15.
  const taskId = randomUUID(), eventId = randomUUID();
  db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,creator_id)
    VALUES (?,'maya',?,'Already-started deliverable','','open',?,?,'maya')`).run(taskId, projectId, now, now);
  db.prepare(`INSERT INTO team_admissions(event_id,project_id,source_task_id,initiator_id,operation_id,original_key,
    revision_id,policy_state,manifest,state,created_at)
    SELECT ?,project_id,?,'maya',?,?,revision_id,'PINNED',manifest,'PENDING',?
    FROM team_revisions WHERE project_id=? AND revision_id='saved-manual'`).run(eventId, taskId, randomUUID(), randomUUID(), now, projectId);
  const runtime = createTeamRuntime({ db });
  try {
    await runtime.wake();
    const saved = db.prepare('SELECT child_id,receipt,state FROM team_admissions WHERE event_id=?').get(eventId);
    assert.equal(saved.state, 'CLOSED');
    const receipt = JSON.parse(saved.receipt);
    assert.equal(receipt.effect, 'CONFIRMED');
    assert.equal(receipt.eventId, eventId);
    assert.equal(receipt.result.value.id, saved.child_id);
    const child = db.prepare('SELECT parent_task_id,origin_event_id,assignee_id FROM tasks WHERE id=?').get(saved.child_id);
    assert.deepEqual({ ...child }, { parent_task_id: taskId, origin_event_id: eventId, assignee_id: 'leo' });
  } finally { await runtime.close(); }
  const queries = inventory(db), snapshot = db => queries.map(sql => db.prepare(sql).all()), before = snapshot(db);
  db.close();
  const settings = '{"provider":"scripted","draft":"Preserve settings bytes"}\n';
  writeFileSync(join(directory, 'ai-authoring.json'), settings);
  return { directory, path, snapshot, before, settings, projectId, empty };
}

test('populated v15 upgrades once without rewriting pins/receipts/Personal drafts/settings; v16 source and evidence reopen and reset backup exactly', async t => {
  const f = await populated15(t);
  let db = openData(f.path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
    assert.deepEqual(f.snapshot(db), f.before);
    assert.equal(db.prepare('SELECT source_bundle FROM team_revisions').get().source_bundle, null);
    assert.deepEqual(db.prepare('SELECT revision_id,draft_version FROM team_drafts ORDER BY project_id').all().map(Object.values), [[null, 0], [null, 0]]);
  } finally { db.close(); }
  db = openData(f.path);
  const api = createTeamCapability(db);
  let saved, evidence;
  try {
    assert.deepEqual(f.snapshot(db), f.before);
    const state = await api.propose('maya', f.projectId, { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: 'Preserve exact source' });
    const result = await api.simulate('maya', f.projectId, { expectedDraftVersion: 1, revisionId: state.draft.revisionId, cases: state.examples });
    saved = api.source('maya', f.projectId, state.draft.revisionId);
    evidence = api.evidence('maya', f.projectId, result.evidenceId);
    f.snapshot(db).forEach((rows, i) => assert.deepEqual(rows.slice(0, f.before[i].length), f.before[i]));
    assert.equal(db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(f.projectId).revision_id, 'saved-manual');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const queries = inventory(db), snapshot = db => queries.map(sql => db.prepare(sql).all());
    const before = snapshot(db);
    await api.close(); db.close(); db = null;
    const reopened = openData(f.path), reader = createTeamCapability(reopened);
    try {
      assert.deepEqual(snapshot(reopened), before);
      assert.deepEqual(reader.source('maya', f.projectId, saved.revisionId), saved);
      assert.deepEqual(reader.evidence('maya', f.projectId, evidence.id), evidence);
    } finally { await reader.close(); reopened.close(); }
    const backupPath = await resetData(f.directory, true);
    const copy = openData(backupPath);
    try { assert.deepEqual(snapshot(copy), before); } finally { copy.close(); }
    const reset = openData(f.path);
    try {
      for (const table of ['team_evidence', 'team_drafts', 'team_admissions', 'team_selections', 'team_revisions', 'project_members'])
        assert.equal(reset.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
      assert.equal(reset.prepare('SELECT count(*) AS n FROM users').get().n, 3);
    } finally { reset.close(); }
  } finally { await api.close(); db?.close(); }
  assert.equal(readFileSync(join(f.directory, 'ai-authoring.json'), 'utf8'), f.settings);
});

test('each schema16 DDL, slot initialization and version marker boundary rolls back with byte-identical v15 data', async t => {
  const f = await populated15(t), original = readFileSync(f.path), exec = DatabaseSync.prototype.exec;
  const starts = [...addTeamCapabilities.matchAll(/^ {2}(?:ALTER TABLE|CREATE TABLE|CREATE INDEX|CREATE TRIGGER|INSERT INTO)\b/gm)].map(m => m.index);
  const statements = starts.map((start, i) => addTeamCapabilities.slice(start, starts[i + 1] ?? addTeamCapabilities.length));
  for (let boundary = 0; boundary <= statements.length; boundary++) {
    let interrupted = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === addTeamCapabilities && boundary < statements.length && this.prepare('PRAGMA user_version').get().user_version === 15) {
        exec.call(this, statements.slice(0, boundary + 1).join('')); interrupted = true;
        throw new Error('Capability migration interrupted');
      }
      const result = exec.call(this, sql);
      if (sql === 'PRAGMA user_version=24' && boundary === statements.length) { interrupted = true; throw new Error('Capability migration interrupted'); }
      return result;
    };
    try { assert.throws(() => openData(f.path), /Capability migration interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(interrupted, true);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
      assert.deepEqual(f.snapshot(db), f.before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('team_drafts','team_evidence','team_source_immutable')").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('team_revisions') WHERE name='source_bundle'").get().n, 0);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(f.path), original);
  }
});

test('schema16 admission detects source/evidence trigger drift and reset verifies new state before deleting', async t => {
  const f = await populated15(t);
  let db = openData(f.path);
  const api = createTeamCapability(db);
  const state = await api.propose('maya', f.projectId, { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: '' });
  const result = await api.simulate('maya', f.projectId, { expectedDraftVersion: 1, revisionId: state.draft.revisionId, cases: state.examples });
  await api.close(); db.close();
  await assert.rejects(resetData(f.directory, true, async (original, target) => {
    await backup(original, target);
    const copy = new DatabaseSync(target);
    try { copy.prepare('DELETE FROM team_evidence WHERE id=?').run(result.evidenceId); } finally { copy.close(); }
  }), /Backup differs/);
  db = openData(f.path);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM team_evidence').get().n, 1); db.exec('DROP TRIGGER team_source_immutable'); }
  finally { db.close(); }
  const before = readFileSync(f.path);
  assert.throws(() => openData(f.path), /Unsupported database schema/);
  assert.deepEqual(readFileSync(f.path), before);
});
