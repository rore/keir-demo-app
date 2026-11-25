import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openData, taskService, resetData } from '../src/data.mjs';
import { addTeamProjects, addTeamCapabilities, addTeamLifecycle, addTeamControls, teamProjectService } from '../src/team-native.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { createTeamRuntime, installTeamRevision } from '../src/team-runtime.mjs';
import { restoreSavedCore } from './fixtures/saved-core-0.3.0.mjs';

let legacyRows, legacyRows17, projectId, proposal, cases, evidenceId, activation17;
const inventory = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
  const fields = db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
  return `SELECT rowid,${fields.join(',')} FROM ${name} ORDER BY rowid`;
});
function schema16(db) {
  const source = readFileSync(new URL('../src/data.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['schema', 'addTaskFields', 'rebuildTaskWorkflow', 'cutoverTaskWorkflow', 'addTaskCreateGuard']) {
    const prefix = `const ${name} = \``, start = source.indexOf(prefix);
    assert.notEqual(start, -1);
    db.exec(source.slice(start + prefix.length, source.indexOf('`;', start + prefix.length)));
  }
  db.exec(addTeamProjects); db.exec(addTeamCapabilities); db.exec('PRAGMA user_version=16');
}
before(async () => {
  const db = openData(':memory:'), api = createTeamCapability(db);
  restoreSavedCore(db, JSON.parse(readFileSync(new URL('./fixtures/saved-core-0.4.0.json', import.meta.url))));
  projectId = taskService(db).createProject('maya', { name: 'Saved Team', mode: 'TEAM' }).id;
  teamProjectService(db).addMember('maya', projectId, { userId: 'leo' });
  const runtime = createTeamRuntime({ db });
  try {
    proposal = await api.propose('maya', projectId, { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: 'Saved v16 intent' });
    cases = proposal.examples;
    const checked = await api.simulate('maya', projectId, { expectedDraftVersion: 1, revisionId: proposal.draft.revisionId, cases });
    evidenceId = checked.evidenceId;
    const source = api.source('maya', projectId, proposal.draft.revisionId);
    installTeamRevision(db, 'maya', projectId, 'manual-policy', Object.fromEntries(['TaskCreated', 'TaskBeforeComplete']
      .map(hook => [hook, Buffer.from(source.artifacts[source.manifest[hook]])])));
    teamProjectService(db).setSelection('maya', projectId, 'manual-policy');
    await taskService(db, { team: runtime }).createTask('maya', { projectId, title: 'Existing work' }, { operationId: randomUUID() });
    await runtime.wake();
    assert.ok(db.prepare('SELECT receipt FROM team_admissions').get().receipt);
    const shape = new DatabaseSync(':memory:');
    try {
      schema16(shape);
      legacyRows = shape.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='sqlite_sequence' ORDER BY name").all().map(({ name }) => {
        const fields = shape.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
        return { name, fields, rows: db.prepare(`SELECT ${fields.join(',')} FROM ${name} ORDER BY rowid`).all() };
      });
      const input = { operationId: randomUUID(), expectedDraftVersion: 1, revisionId: proposal.draft.revisionId, evidenceId, cases };
      const approved = await api.approve('maya', projectId, input);
      activation17 = await api.activate('maya', projectId, { ...input, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: 1 });
      shape.exec(addTeamLifecycle);
      legacyRows17 = shape.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='sqlite_sequence' ORDER BY name").all().map(({ name }) => {
        const fields = shape.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
        return { name, fields, rows: db.prepare(`SELECT ${fields.join(',')} FROM ${name} ORDER BY rowid`).all() };
      });
    } finally { shape.close(); }
  } finally { await runtime.close(); await api.close(); db.close(); }
});
function populated16(t, version = 16) {
  const directory = mkdtempSync(join(tmpdir(), 'team-lifecycle-v16-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  try {
    schema16(db);
    if (version >= 17) { db.exec(addTeamLifecycle); db.exec('PRAGMA user_version=17'); }
    if (version === 18) { db.exec(addTeamControls); db.exec('PRAGMA user_version=18'); }
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    for (const { name, fields, rows } of version >= 17 ? legacyRows17 : legacyRows) {
      const insert = db.prepare(`INSERT INTO ${name}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
      for (const row of rows) insert.run(...fields.map(field => row[field]));
    }
    db.exec('COMMIT');
    const queries = inventory(db), snapshot = db => queries.map(sql => db.prepare(sql).all()), before = snapshot(db);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    writeFileSync(join(directory, 'ai-authoring.json'), '{"provider":"scripted","saved":"untouched"}\n');
    return { directory, path, snapshot, before };
  } finally { db.close(); }
}

test('populated v16 preserves old policy/source/evidence/receipts and Personal data; new choices reopen and survive a verified reset backup', async t => {
  const f = populated16(t);
  let db = openData(f.path), api = createTeamCapability(db);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
    assert.deepEqual(f.snapshot(db), f.before);
    assert.equal(db.prepare('SELECT generation FROM team_selections').get().generation, 0);
    assert.equal(db.prepare('SELECT source_bundle FROM team_revisions WHERE revision_id=?').get('manual-policy').source_bundle, null);
    for (const table of ['team_approvals', 'team_activations']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(api.state('maya', projectId).selection.activation, null);
    const input = { operationId: randomUUID(), expectedDraftVersion: 1, revisionId: proposal.draft.revisionId, evidenceId, cases };
    const approved = await api.approve('maya', projectId, input);
    const body = { ...input, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: 0 };
    const active = await api.activate('maya', projectId, body);
    const queries = inventory(db), snapshot = db => queries.map(sql => db.prepare(sql).all()), before = snapshot(db);
    await api.close(); db.close(); db = null;
    const reopened = openData(f.path), read = createTeamCapability(reopened);
    try {
      assert.deepEqual(snapshot(reopened), before);
      assert.deepEqual(read.readOperation('maya', projectId, body.operationId).receipt, active.receipt);
      assert.deepEqual((await read.activate('maya', projectId, body)).receipt, active.receipt);
      assert.deepEqual(snapshot(reopened), before);
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { await read.close(); reopened.close(); }
    const backupPath = await resetData(f.directory, true), copy = openData(backupPath);
    try { assert.deepEqual(snapshot(copy), before); } finally { copy.close(); }
    const reset = openData(f.path);
    try {
      for (const table of ['team_approvals', 'team_activations', 'team_admissions', 'team_selections', 'team_evidence'])
        assert.equal(reset.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
      assert.equal(reset.prepare('SELECT count(*) AS n FROM users').get().n, 3);
    } finally { reset.close(); }
    assert.equal(readFileSync(join(f.directory, 'ai-authoring.json'), 'utf8'), '{"provider":"scripted","saved":"untouched"}\n');
  } finally { await api.close(); db?.close(); }
});

test('each lifecycle DDL and marker boundary rolls back with byte-identical populated v16 data', t => {
  const f = populated16(t), original = readFileSync(f.path), exec = DatabaseSync.prototype.exec;
  const starts = [...addTeamLifecycle.matchAll(/^ {2}(?:ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE TRIGGER)\b/gm)].map(m => m.index);
  const statements = starts.map((start, i) => addTeamLifecycle.slice(start, starts[i + 1] ?? addTeamLifecycle.length));
  for (let boundary = 0; boundary <= statements.length; boundary++) {
    let interrupted = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === addTeamLifecycle && boundary < statements.length && this.prepare('PRAGMA user_version').get().user_version === 16) {
        exec.call(this, statements.slice(0, boundary + 1).join('')); interrupted = true;
        throw new Error('Lifecycle migration interrupted');
      }
      const result = exec.call(this, sql);
      if (sql === 'PRAGMA user_version=19' && boundary === statements.length) { interrupted = true; throw new Error('Lifecycle migration interrupted'); }
      return result;
    };
    try { assert.throws(() => openData(f.path), /Lifecycle migration interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(interrupted, true);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
      assert.deepEqual(f.snapshot(db), f.before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('team_selections') WHERE name='generation'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('team_approvals','team_activations')").get().n, 0);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(f.path), original);
  }
});

test('new receipts are verified before reset and generation/immutability trigger drift prevents admission', async t => {
  const f = populated16(t), db = openData(f.path), api = createTeamCapability(db);
  const input = { operationId: randomUUID(), expectedDraftVersion: 1, revisionId: proposal.draft.revisionId, evidenceId, cases };
  const approved = await api.approve('maya', projectId, input);
  await api.activate('maya', projectId, { ...input, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: 0 });
  await api.close(); db.close();
  await assert.rejects(resetData(f.directory, true, async (original, target) => {
    await backup(original, target);
    const copy = new DatabaseSync(target);
    try { copy.exec('DELETE FROM team_activations'); } finally { copy.close(); }
  }), /Backup differs/);
  const current = openData(f.path);
  try { assert.equal(current.prepare('SELECT count(*) AS n FROM team_activations').get().n, 1); current.exec('DROP TRIGGER team_selection_generation'); }
  finally { current.close(); }
  const before = readFileSync(f.path);
  assert.throws(() => openData(f.path), /Unsupported database schema/);
  assert.deepEqual(readFileSync(f.path), before);
});

test('populated v17 preserves all old pins/Personal data and activation attribution, then exact control receipts reopen and reset backs them up', async t => {
  const f = populated16(t, 17);
  let db = openData(f.path), api = createTeamCapability(db);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
    assert.deepEqual(f.snapshot(db), f.before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM team_controls').get().n, 0);
    assert.deepEqual(api.readOperation('maya', projectId, activation17.receipt.operationId).receipt, activation17.receipt);
    const input = { operationId: randomUUID(), targetRevisionId: proposal.draft.revisionId,
      expectedSelectionRevisionId: proposal.draft.revisionId, expectedSelectionGeneration: activation17.current.generation };
    const deactivated = await api.deactivate('maya', projectId, input);
    const revoked = await api.revoke('maya', projectId, { ...input, operationId: randomUUID(),
      expectedSelectionRevisionId: null, expectedSelectionGeneration: deactivated.current.generation });
    const queries = inventory(db), snapshot = db => queries.map(sql => db.prepare(sql).all()), before = snapshot(db);
    await api.close(); db.close(); db = null;
    const reopened = openData(f.path), read = createTeamCapability(reopened);
    try {
      assert.deepEqual(snapshot(reopened), before);
      assert.deepEqual(read.readOperation('maya', projectId, input.operationId).receipt, deactivated.receipt);
      assert.deepEqual(read.readOperation('maya', projectId, revoked.receipt.operationId).receipt, revoked.receipt);
      assert.deepEqual((await read.deactivate('maya', projectId, input)).receipt, deactivated.receipt);
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(snapshot(reopened), before);
    } finally { await read.close(); reopened.close(); }
    await assert.rejects(resetData(f.directory, true, async (original, target) => {
      await backup(original, target);
      const copy = new DatabaseSync(target);
      try { copy.exec('DELETE FROM team_controls'); } finally { copy.close(); }
    }), /Backup differs/);
    const copy = openData(await resetData(f.directory, true));
    try { assert.deepEqual(snapshot(copy), before); } finally { copy.close(); }
    const reset = openData(f.path);
    try { assert.equal(reset.prepare('SELECT count(*) AS n FROM team_controls').get().n, 0); } finally { reset.close(); }
    assert.equal(readFileSync(join(f.directory, 'ai-authoring.json'), 'utf8'), '{"provider":"scripted","saved":"untouched"}\n');
  } finally { await api.close(); db?.close(); }
});

test('schema 19 preserves historical holds and legacy bytes; interrupted settlement migration rolls back', t => {
  const f = populated16(t, 18), old = new DatabaseSync(f.path);
  old.exec(`UPDATE authoring_budget SET reserved_micros=319488 WHERE id=1;
    INSERT INTO authoring_conversations VALUES ('legacy','maya','operation',1,'run','IDLE',0,0,'{}','[]','{}',0);
    INSERT INTO authoring_operations VALUES ('legacy','maya','operation','hash','run',1);
    INSERT INTO authoring_dispatches VALUES ('legacy','maya','run',1,'provider',NULL,319488,'SUCCESS')`);
  const queries = inventory(old), snapshot = db => queries.map(sql => db.prepare(sql).all()), before = snapshot(old);
  old.close();
  const bytes = readFileSync(f.path), exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'PRAGMA user_version=19') throw new Error('Settlement migration interrupted');
    return exec.call(this, sql);
  };
  try { assert.throws(() => openData(f.path), /Settlement migration interrupted/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(readFileSync(f.path), bytes);
  const db = openData(f.path);
  try {
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('SELECT estimated_micros FROM authoring_dispatches').get().estimated_micros, null);
    assert.equal(db.prepare('SELECT cleared_estimated_micros FROM authoring_budget').get().cleared_estimated_micros, 0);
    assert.throws(() => db.exec('UPDATE authoring_dispatches SET estimated_micros=1'), /immutable/);
  } finally { db.close(); }
});

test('every schema18 control DDL and marker boundary rolls back populated v17 byte-for-byte', t => {
  const f = populated16(t, 17), original = readFileSync(f.path), exec = DatabaseSync.prototype.exec;
  const starts = [...addTeamControls.matchAll(/^ {2}(?:CREATE TABLE|CREATE TRIGGER)\b/gm)].map(m => m.index);
  const statements = starts.map((start, i) => addTeamControls.slice(start, starts[i + 1] ?? addTeamControls.length));
  for (let boundary = 0; boundary <= statements.length; boundary++) {
    let interrupted = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === addTeamControls && boundary < statements.length && this.prepare('PRAGMA user_version').get().user_version === 17) {
        exec.call(this, statements.slice(0, boundary + 1).join('')); interrupted = true;
        throw new Error('Control migration interrupted');
      }
      const result = exec.call(this, sql);
      if (sql === 'PRAGMA user_version=19' && boundary === statements.length) { interrupted = true; throw new Error('Control migration interrupted'); }
      return result;
    };
    try { assert.throws(() => openData(f.path), /Control migration interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(interrupted, true);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
      assert.deepEqual(f.snapshot(db), f.before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='team_controls'").get().n, 0);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(f.path), original);
  }
});
