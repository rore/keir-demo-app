import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, USERS, acquireDataLock, openData, resetData, taskService } from '../src/data.mjs';
import { DatabaseSync, backup } from 'node:sqlite';

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
  assert.throws(() => db.prepare('INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('bad', 'maya', leoSeed.id, 'bad', '', 'open', 'a', 'a', null), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT count(*) n FROM projects WHERE owner_id=?').get('maya').n, count);
});

test('initial seed is idempotent and all three users persist through reopen', t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  let db = openData(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.deepEqual(db.prepare('SELECT owner_id,hook_id,revision_id,generation,binding_pins FROM extension_selections ORDER BY owner_id').all()
    .map(row => Object.values(row)), ['leo', 'maya', 'sam'].map(id => [id, 'TaskCompleted', null, 0, null]));
  assert.equal(db.prepare('SELECT count(*) n FROM extension_revisions').get().n, 0);
  assert.deepEqual(taskService(db).listProjects('maya').length, 1);
  assert.deepEqual(USERS.map(user => taskService(db).listProjects(user.id).length), [1, 1, 1]);
  for (const user of USERS) taskService(db).createProject(user.id, { name: `${user.name} extra` });
  db.close();
  db = openData(path);
  cleanup(t, dir, () => db.close());
  for (const user of USERS) assert.equal(taskService(db).listProjects(user.id).length, 2);
});

test('fresh schema, seed and current marker roll back together on initialization failure', t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  cleanup(t, dir);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql === 'PRAGMA user_version=11') throw new Error('initialization blocked');
    return result;
  };
  try { assert.throws(() => openData(path), /initialization blocked/); }
  finally { DatabaseSync.prototype.exec = exec; }
  const raw = new DatabaseSync(path);
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 0);
    assert.deepEqual(raw.prepare('SELECT name FROM sqlite_schema').all(), []);
  } finally { raw.close(); }
  assert.throws(() => openData(path), /Unsupported database format/);
});

test('native tags normalize, preserve exact stored text on tag-only edits and survive reopen', t => {
  const dir = sandbox(), path = join(dir, 'app.sqlite');
  let db = openData(path);
  cleanup(t, dir, () => db.close());
  let service = taskService(db);
  const projectId = service.listProjects('maya')[0].id;
  const task = service.createTask('maya', { projectId, title: 'Tag me', tags: [' J\u030C ', '\u01F0', ' CAFE\u0301 ', 'caf\u00E9'] });
  assert.deepEqual(task.tags, ['\u01F0', 'caf\u00E9']);
  assert.deepEqual(service.searchTasks('maya', projectId, { tag: ' J\u030C ' }).items.map(row => row.id), [task.id]);
  assert.deepEqual(service.editTask('maya', task.id, { title: 'Edited', notes: 'Updated' }).tags, task.tags);

  db.prepare('UPDATE tasks SET title=?, notes=?, updated_at=? WHERE id=?').run('  old\u0000title  ', ' old\u0000notes ', 'old', task.id);
  const exactText = () => db.prepare('SELECT hex(title) AS title, hex(notes) AS notes FROM tasks WHERE id=?').get(task.id);
  const before = exactText();
  const edited = service.editTask('maya', task.id, { tags: [' Later ', ...Array(8).fill('later')] });
  assert.deepEqual(edited.tags, ['later']);
  assert.deepEqual(exactText(), before);
  assert.notEqual(edited.updatedAt, 'old');
  assert.deepEqual(service.listTasks('maya', projectId).find(row => row.id === task.id).tags, ['later']);

  const count = service.listTasks('maya', projectId).length;
  for (const tags of [null, 'x', [42], [' '], ['x,y'], ['x\u0000y'], ['x\u0085y'], ['\uD800'], ['😀'.repeat(17)], Array.from({ length: 9 }, (_, i) => String(i))]) {
    expectStatus(400, () => service.createTask('maya', { projectId, title: 'Invalid', tags }));
    expectStatus(400, () => service.editTask('maya', task.id, { tags }));
  }
  assert.equal(service.listTasks('maya', projectId).length, count);
  assert.deepEqual(service.getTask('maya', task.id).tags, ['later']);
  expectStatus(404, () => service.editTask('leo', task.id, { tags: [] }));
  const boundary = ['😀'.repeat(16), '1', '2', '3', '4', '5', '6', '7'];
  assert.deepEqual(service.editTask('maya', task.id, { tags: boundary }).tags, boundary);
  db.close(); db = openData(path);
  service = taskService(db);
  assert.deepEqual(service.getTask('maya', task.id).tags, boundary);
  assert.deepEqual(exactText(), before);
  assert.deepEqual(service.editTask('maya', task.id, { title: 'Now', notes: '', tags: [] }).tags, []);
  assert.deepEqual(service.editTask('maya', task.id, { tags: ['again'] }).tags, ['again']);
  assert.deepEqual(service.editTask('maya', task.id, { tags: [] }).tags, []);
});

test('native priority and UTC millisecond due time validate and update independently of task text', t => {
  const dir = sandbox(), db = openData(join(dir, 'app.sqlite'));
  cleanup(t, dir, () => db.close());
  const service = taskService(db), projectId = service.listProjects('maya')[0].id;
  const task = service.createTask('maya', { projectId, title: 'Legacy\u0000task', notes: 'Old\u0000notes' });
  assert.deepEqual([task.priority, task.dueAt], ['normal', null]);
  const exactText = () => db.prepare('SELECT hex(title), hex(notes) FROM tasks WHERE id=?').get(task.id);
  const before = exactText();
  const beforeDst = '2025-03-08T14:30:00.123Z', afterDst = '2025-03-15T14:30:00.123Z';
  const first = service.editTask('maya', task.id, { priority: 'high', dueAt: beforeDst });
  const second = service.editTask('maya', task.id, { dueAt: afterDst });
  assert.deepEqual([first.dueAt, second.dueAt], [beforeDst, afterDst]);
  assert.equal(Date.parse(second.dueAt) - Date.parse(first.dueAt), 168 * 60 * 60 * 1000);
  assert.equal(service.editTask('maya', task.id, { priority: 'low' }).dueAt, afterDst);
  assert.deepEqual(exactText(), before);
  assert.equal(service.editTask('maya', task.id, { dueAt: null }).priority, 'low');
  assert.equal(service.getTask('maya', task.id).dueAt, null);
  const unchanged = service.getTask('maya', task.id);
  for (const fields of [{ priority: null }, { priority: 'urgent' }, { dueAt: '' }, { dueAt: '2025-02-28' },
    { dueAt: '2025-02-29T00:00:00.000Z' }, { dueAt: '2025-02-28T24:00:00.000Z' }, { dueAt: '0000-01-01T00:00:00.000Z' },
    { dueAt: '2026-04-01T00:00:00Z' }, { dueAt: '2025-03-08T09:30:00.123-05:00' }, { dueAt: Date.parse(beforeDst) }]) {
    expectStatus(400, () => service.createTask('maya', { projectId, title: 'Invalid fields', ...fields }));
    expectStatus(400, () => service.editTask('maya', task.id, fields));
  }
  for (const fields of [{}, { notes: 'Missing title', dueAt: null }, { title: 'Missing notes', priority: 'high' }])
    expectStatus(400, () => service.editTask('maya', task.id, fields));
  expectStatus(404, () => service.editTask('leo', task.id, { priority: 'high', dueAt: beforeDst }));
  assert.deepEqual(service.getTask('maya', task.id), unchanged);
  for (const dueAt of ['2026-02-29T00:00:00.000Z', '2026-02-28T24:00:00.000Z', '2026-02-28T00:00:00Z', 'invalid'])
    assert.throws(() => db.prepare('UPDATE tasks SET due_at=? WHERE id=?').run(dueAt, task.id), /CHECK/);
  assert.throws(() => db.prepare("UPDATE tasks SET priority='urgent' WHERE id=?").run(task.id), /CHECK/);
});

test('search filters a project before paging, with exact tags and literal ASCII-folded text beyond NUL', t => {
  const dir = sandbox(), db = openData(join(dir, 'app.sqlite'));
  cleanup(t, dir, () => db.close());
  const service = taskService(db), owner = 'maya';
  const { id: projectId } = service.createProject(owner, { name: 'Search fixture' });
  const add = input => service.createTask(owner, { projectId, title: 'Ordinary', ...input });
  for (let index = 0; index < 30; index++) add({ notes: 'needle XX É', tags: ['ready'] });
  const matching = Array.from({ length: 27 }, (_, index) => add(index % 2
    ? { title: 'NEEDLE %_ É', tags: ['ready'] }
    : { notes: 'before\u0000needle %_ É', tags: ['ready'] }));
  const widerTag = add({ notes: 'needle %_ É', tags: ['ready later'] });
  add({ notes: 'needle %_ é', tags: ['ready'] });
  const completed = service.completeTask(owner, matching[0].id);
  assert.equal(completed.status, 'completed');
  const anchorTime = '2026-01-02T00:00:00.000Z';
  db.prepare('UPDATE tasks SET created_at=? WHERE project_id=?').run(anchorTime, projectId);
  db.prepare("UPDATE tasks SET created_at='2026-01-01T00:00:00.000Z' WHERE project_id=? AND notes=?").run(projectId, 'needle XX É');
  const filters = { q: '  NeEdLe %_ É  ', tag: ' READY ' };
  const ids = matching.map(row => row.id).sort();
  const search = (options = filters) => service.searchTasks(owner, projectId, options);
  const first = search();
  assert.deepEqual(first.items.map(row => row.id), ids.slice(0, 25));
  assert.equal(first.nextAfter, ids[24]);
  const second = search({ ...filters, after: first.nextAfter });
  assert.deepEqual(second.items.map(row => row.id), ids.slice(25));
  assert.equal(second.nextAfter, null);
  assert.equal([...first.items, ...second.items].find(row => row.id === completed.id).status, 'completed');
  assert.equal(search({ ...filters, after: ids[1] }).items.length, 25);
  assert.equal(search({ ...filters, after: ids[1] }).nextAfter, null);
  assert.deepEqual(search({ ...filters, after: ids.at(-1) }), { items: [], nextAfter: null });
  assert.deepEqual(search({ q: 'nothing matches' }), { items: [], nextAfter: null });
  assert.deepEqual(search({ tag: 'ready later' }).items.map(row => row.id), [widerTag.id]);
  for (const invalid of [{}, { q: ' ' }, { tag: ' ' }, { q: ['x'] }, { q: 'x'.repeat(121) }, { tag: 'x,y' }, { ...filters, after: '' }]) {
    expectStatus(400, () => search(invalid));
  }
  assert.equal(service.listTasks(owner, projectId).length, 59);
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
  }), /Backup verification failed/);
  for (const change of ['PRAGMA user_version=9', 'DROP TRIGGER task_receipt_immutable']) {
    await assert.rejects(resetData(dir, true, async (source, backupPath) => {
      await backup(source, backupPath);
      const copy = new DatabaseSync(backupPath);
      try { copy.exec(change); } finally { copy.close(); }
    }), /Backup verification failed/);
  }
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
  db.close();
  await assert.rejects(resetData(dir, true, async (source, backupPath) => {
    await backup(source, backupPath);
    source.exec("CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON main.projects WHEN NEW.name = 'A quieter workspace' BEGIN SELECT RAISE(ABORT, 'seed blocked'); END");
  }), /seed blocked/);
  const check = openData(path);
  assert.ok(taskService(check).listProjects('sam').some(row => row.name === 'Survives failed reset'));
  check.close();
  const release = acquireDataLock(dir);
  release();
});
