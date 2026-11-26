import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData } from '../src/data.mjs';
import { addTeamProjects } from '../src/team-native.mjs';
import { restoreSavedCore } from './fixtures/saved-core-0.3.0.mjs';

function populated14(t) {
  const directory = mkdtempSync(join(tmpdir(), 'team-v14-upgrade-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  const source = readFileSync(new URL('../src/data.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['schema', 'addTaskFields', 'rebuildTaskWorkflow', 'cutoverTaskWorkflow', 'addTaskCreateGuard']) {
    const declaration = `const ${name} = \``, start = source.indexOf(declaration);
    assert.notEqual(start, -1);
    const end = source.indexOf('`;', start + declaration.length);
    db.exec(source.slice(start + declaration.length, end));
  }
  for (const owner of ['maya', 'leo', 'sam']) {
    db.prepare('INSERT INTO users VALUES (?,?)').run(owner, owner);
    for (const hook of ['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate'])
      db.prepare('INSERT INTO extension_selections(owner_id,hook_id,generation) VALUES (?,?,0)').run(owner, hook);
  }
  db.exec('INSERT INTO authoring_budget VALUES (1,321); PRAGMA user_version=14');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/saved-core-0.4.0.json', import.meta.url)));
  restoreSavedCore(db, fixture);
  const taskId = 'saved-operation-task', now = '2026-01-02T03:04:05.678Z';
  db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at)
    VALUES (?,'maya',?,'Saved work','Draft notes','open',?,?)`).run(taskId, fixture.projectId, now, now);
  db.prepare('INSERT INTO task_create_operations VALUES (?,?,?,?)').run('maya', '8cae5c80-4a66-479e-997f-4601d644a715',
    Buffer.from(JSON.stringify({ projectId: fixture.projectId, title: 'Saved work' })),
    Buffer.from(JSON.stringify({ state: 'CREATED', task: { id: taskId } })));
  const queries = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
    return `SELECT rowid,${columns.join(',')} FROM ${name} ORDER BY rowid`;
  });
  const snapshot = db => queries.map(sql => db.prepare(sql).all());
  const before = snapshot(db);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  const settings = '{ "provider": "scripted", "draft": "Saved fictional configuration" }\n';
  writeFileSync(join(directory, 'ai-authoring.json'), settings);
  return { directory, path, snapshot, before, settings };
}

test('populated v14 migrates additively, preserving every old column, Personal artifact/draft/operation and settings through restart', t => {
  const f = populated14(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openData(f.path);
    try {
         assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
      assert.deepEqual(f.snapshot(db), f.before);
      assert.deepEqual(db.prepare('SELECT DISTINCT mode FROM projects').all().map(Object.values), [['PERSONAL']]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM team_admissions').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM project_members').get().n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    assert.equal(readFileSync(join(f.directory, 'ai-authoring.json'), 'utf8'), f.settings);
  }
});

test('every v15 DDL boundary and marker write rolls back without partial authority or reseeding', t => {
  const f = populated14(t), original = readFileSync(f.path), exec = DatabaseSync.prototype.exec;
  const starts = [...addTeamProjects.matchAll(/^ {2}(?:ALTER TABLE|CREATE TABLE|CREATE INDEX|CREATE TRIGGER)\b/gm)].map(match => match.index);
  const statements = starts.map((start, index) => addTeamProjects.slice(start, starts[index + 1] ?? addTeamProjects.length));
  for (let boundary = 0; boundary <= statements.length; boundary++) {
    let interrupted = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === addTeamProjects && boundary < statements.length) {
        exec.call(this, statements.slice(0, boundary + 1).join(''));
        interrupted = true;
        throw new Error('Team migration interrupted');
      }
      const result = exec.call(this, sql);
       if (sql === 'PRAGMA user_version=24' && boundary === statements.length) {
        interrupted = true;
        throw new Error('Team migration interrupted');
      }
      return result;
    };
    try { assert.throws(() => openData(f.path), /Team migration interrupted/); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(interrupted, true);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
      assert.deepEqual(f.snapshot(db), f.before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'team_%'").get().n, 0);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(f.path), original);
  }
});
