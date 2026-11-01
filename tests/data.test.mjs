import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, USERS, acquireDataLock, openData, resetData, taskService } from '../src/data.mjs';
import { DatabaseSync } from 'node:sqlite';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'keir-native-data-'));
  return dir;
}
function cleanup(t, dir, close = () => {}) { t.after(() => { close(); rmSync(dir, { recursive: true, force: true }); }); }

function expectStatus(status, action) {
  assert.throws(action, error => error instanceof AppError && error.status === status);
}

test('services validate CRUD, bounds, ownership and completion without partial writes', t => {
  const dir = sandbox(), db = openData(join(dir, 'app.sqlite'));
  cleanup(t, dir, () => db.close());
  const maya = taskService(db), leo = taskService(db);
  const [mayaSeed] = maya.listProjects('maya');
  const [leoSeed] = leo.listProjects('leo');
  assert.notEqual(mayaSeed.id, leoSeed.id);
  const project = maya.createProject('maya', { name: '  Extra  ' });
  assert.equal(project.name, 'Extra');
  assert.equal(maya.renameProject('maya', project.id, { name: 'Renamed' }).name, 'Renamed');
  for (const [value, expected] of [['x'.repeat(80), 80], ['x'.repeat(81), 400], [' ', 400]]) {
    if (expected === 80) assert.equal(maya.createProject('maya', { name: value }).name.length, 80);
    else expectStatus(expected, () => maya.createProject('maya', { name: value }));
  }
  expectStatus(400, () => maya.createProject('maya', { name: 'ok', ownerId: 'leo' }));
  expectStatus(400, () => maya.createProject('maya', {}));
  expectStatus(400, () => maya.createTask('maya', { projectId: project.id, title: 't', ownerId: 'leo' }));
  expectStatus(400, () => maya.createTask('maya', { projectId: project.id, title: 'x'.repeat(121) }));
  expectStatus(400, () => maya.createTask('maya', { projectId: project.id, title: ' ', notes: '' }));
  assert.equal(maya.createTask('maya', { projectId: project.id, title: 't'.repeat(120), notes: 'n'.repeat(4000) }).title.length, 120);
  expectStatus(400, () => maya.createTask('maya', { projectId: project.id, title: 'ok', notes: 'n'.repeat(4001) }));
  expectStatus(404, () => maya.createTask('maya', { projectId: leoSeed.id, title: 'foreign' }));
  expectStatus(404, () => maya.getTask('maya', 'missing'));
  expectStatus(404, () => maya.renameProject('maya', leoSeed.id, { name: 'steal' }));
  expectStatus(404, () => maya.listTasks('maya', leoSeed.id));

  const task = maya.createTask('maya', { projectId: project.id, title: ' initial ', notes: '' });
  assert.equal(task.title, 'initial');
  assert.equal(maya.editTask('maya', task.id, { title: 'Edited', notes: 'notes' }).notes, 'notes');
  expectStatus(400, () => maya.editTask('maya', task.id, { notes: '' }));
  assert.equal(maya.getTask('maya', task.id).title, 'Edited');
  expectStatus(404, () => leo.getTask('leo', task.id));
  const completed = maya.completeTask('maya', task.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.equal(maya.completeTask('maya', task.id).completedAt, completed.completedAt);
  assert.equal(maya.listTasks('maya', project.id).some(row => row.id === task.id), true);
  assert.equal(maya.listTasks('maya', mayaSeed.id).length > 0, true);

  const count = db.prepare('SELECT count(*) n FROM projects WHERE owner_id=?').get('maya').n;
  assert.throws(() => db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('bad', 'maya', leoSeed.id, 'bad', '', 'open', 'a', 'a', null));
  assert.equal(db.prepare('SELECT count(*) n FROM projects WHERE owner_id=?').get('maya').n, count);
});

test('initial seed is idempotent and all three users persist through reopen', t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  let db = openData(path);
  assert.deepEqual(taskService(db).listProjects('maya').length, 1);
  assert.deepEqual(USERS.map(user => taskService(db).listProjects(user.id).length), [1, 1, 1]);
  for (const user of USERS) taskService(db).createProject(user.id, { name: `${user.name} extra` });
  db.close();
  db = openData(path);
  cleanup(t, dir, () => db.close());
  for (const user of USERS) assert.equal(taskService(db).listProjects(user.id).length, 2);
});

test('reset requires confirmation, holds exclusive lock, verifies backup and restores it', async t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  cleanup(t, dir);
  const db = openData(path);
  taskService(db).createProject('maya', { name: 'Keep me in backup' });
  db.close();
  await assert.rejects(resetData(dir, false), /--confirm/);
  const release = acquireDataLock(dir);
  await assert.rejects(resetData(dir, true), /locked/);
  release();
  let held = false;
  await assert.rejects(resetData(dir, true, async () => {
    held = true;
    assert.throws(() => acquireDataLock(dir), /locked/);
    throw new Error('backup failed');
  }), /backup failed/);
  assert.equal(held, true);
  await assert.rejects(resetData(dir, true, async (_source, backupPath) => {
    const wrongBackup = openData(backupPath);
    wrongBackup.close();
  }), /Backup differs/);
  await assert.rejects(resetData(dir, true, async (_source, backupPath) => {
    const invalidBackup = new DatabaseSync(backupPath);
    invalidBackup.exec('CREATE TABLE unrelated(value TEXT)');
    invalidBackup.close();
  }));
  const afterFailure = openData(path);
  assert.ok(taskService(afterFailure).listProjects('maya').some(row => row.name === 'Keep me in backup'));
  afterFailure.close();

  const backupPath = await resetData(dir, true);
  const restored = openData(backupPath);
  assert.ok(taskService(restored).listProjects('maya').some(row => row.name === 'Keep me in backup'));
  restored.close();
  const reset = openData(path);
  assert.equal(taskService(reset).listProjects('maya').length, 1);
  reset.close();
});

test('failed reset transaction rolls back and releases lock', async t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  cleanup(t, dir);
  const db = openData(path);
  taskService(db).createProject('sam', { name: 'Survives failed reset' });
  db.exec("CREATE TRIGGER fail_seed BEFORE INSERT ON projects WHEN NEW.name = 'A quieter workspace' BEGIN SELECT RAISE(ABORT, 'seed blocked'); END");
  db.close();
  await assert.rejects(resetData(dir, true), /seed blocked/);
  const check = openData(path);
  assert.ok(taskService(check).listProjects('sam').some(row => row.name === 'Survives failed reset'));
  check.close();
  const release = acquireDataLock(dir);
  release();
});
