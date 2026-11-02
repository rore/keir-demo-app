import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadCatalog } from './extension-catalog.mjs';

const lifecycleTables = ['extension_approvals', 'extension_evidence', 'extension_history', 'extension_selections', 'extension_states', 'extension_revisions'];
function seedLifecycle(db) {
  let catalog = [];
  try { catalog = loadCatalog(); } catch { /* Invalid deployment leaves native tasks usable with no advice. */ }
  for (const user of USERS) {
    db.prepare('INSERT INTO extension_states VALUES (?, 0, NULL)').run(user.id);
    const template = catalog.find(item => item.id === (user.id === 'maya' ? 'pending' : user.id === 'leo' ? 'attention' : ''));
    const revisionId = template ? randomUUID() : null;
    if (template) db.prepare('INSERT INTO extension_revisions VALUES (?, ?, ?, ?, ?)').run(revisionId, user.id, template.id, template.identity, 'operator');
    db.prepare('INSERT INTO extension_selections VALUES (?, ?, ?)').run(user.id, revisionId, template ? 1 : 0);
    if (template) db.prepare('INSERT INTO extension_history(owner_id, revision_id, generation, operation) VALUES (?, ?, 1, ?)').run(user.id, revisionId, 'operator');
  }
}

function migrateLifecycle(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE extension_revisions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), template_id TEXT NOT NULL,
        identity TEXT NOT NULL, provenance TEXT NOT NULL CHECK(provenance IN ('operator','customer')), UNIQUE(id,owner_id)) STRICT;
      CREATE TABLE extension_states(owner_id TEXT PRIMARY KEY REFERENCES users(id), draft_version INTEGER NOT NULL CHECK(draft_version>=0),
        draft_id TEXT, FOREIGN KEY(draft_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
      CREATE TABLE extension_selections(owner_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT,
        generation INTEGER NOT NULL CHECK(generation>=0), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
      CREATE TABLE extension_evidence(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT NOT NULL,
        identity TEXT NOT NULL, suite_identity TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=131072),
        passed INTEGER NOT NULL CHECK(passed IN (0,1)), UNIQUE(id,owner_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
      CREATE TABLE extension_approvals(owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
        PRIMARY KEY(owner_id,revision_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
        FOREIGN KEY(evidence_id,owner_id) REFERENCES extension_evidence(id,owner_id)) STRICT;
      CREATE TABLE extension_history(id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT,
        generation INTEGER NOT NULL, operation TEXT NOT NULL, FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
      CREATE INDEX extension_history_owner ON extension_history(owner_id,id);
      CREATE INDEX extension_evidence_revision ON extension_evidence(owner_id,revision_id);
    `);
    seedLifecycle(db);
    db.exec('PRAGMA user_version = 2');
  });
}

export const USERS = [
  { id: 'maya', name: 'Maya', description: 'A small design practice', project: 'The spring collection', tasks: ['Gather material references', 'Refine the packaging sketches', 'Send the first concept'] },
  { id: 'leo', name: 'Leo', description: 'Good things, made together', project: 'Neighbourhood workshop', tasks: ['Plan the Saturday session', 'Check the tool cupboard', 'Share the workshop notes'] },
  { id: 'sam', name: 'Sam', description: 'Space for the next idea', project: 'A quieter workspace', tasks: ['Sketch the reading corner', 'Choose a desk lamp', 'Clear a little room'] },
];

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const notFound = () => new AppError(404, 'That item is not available.');

export function acquireDataLock(directory) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'app.lock');
  const marker = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Demo data is locked. Stop its owning app before seed/reset/start. For a stale lock, verify that owner has stopped before deliberately removing app.lock; it is never removed automatically.');
    throw error;
  }
  try { writeFileSync(fd, marker); }
  catch (error) { closeSync(fd); unlinkSync(path); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    if (readFileSync(path, 'utf8') === marker) unlinkSync(path);
  };
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedRows(db) {
  const now = new Date().toISOString();
  for (const user of USERS) {
    db.prepare('INSERT INTO users(id, name) VALUES (?, ?)').run(user.id, user.name);
    const projectId = randomUUID();
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(projectId, user.id, user.project, now, now);
    user.tasks.forEach((title, index) => {
      db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(), user.id, projectId, title, '', index === 2 ? 'completed' : 'open', now, now, index === 2 ? now : null);
    });
  }
}

export function openData(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Foreign keys are required.');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length) throw new Error('Unrecognized database; no data was reset.');
      transaction(db, () => {
        db.exec(`
          CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
          CREATE TABLE projects(
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
            name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(id, owner_id)
          ) STRICT;
          CREATE TABLE tasks(
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
            title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
            notes TEXT NOT NULL CHECK(length(notes) <= 4000),
            status TEXT NOT NULL CHECK(status IN ('open', 'completed')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
            FOREIGN KEY(project_id, owner_id) REFERENCES projects(id, owner_id),
            CHECK((status = 'open' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL))
          ) STRICT;
          CREATE INDEX tasks_by_project ON tasks(owner_id, project_id, created_at);
          PRAGMA user_version = 1;
        `);
        seedRows(db);
      });
    } else if (![1, 2].includes(version)) throw new Error('Unsupported database version; no data was reset.');
    if (version !== 2) migrateLifecycle(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function resetData(directory, confirmed, backupDatabase = backup) {
  if (!confirmed) throw new Error('Reset requires --confirm and a stopped app.');
  const release = acquireDataLock(directory);
  let db;
  try {
    db = openData(join(resolve(directory), 'app.sqlite'));
    const backupDir = join(resolve(directory), 'backups');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `${Date.now()}-${randomUUID()}.sqlite`);
    await backupDatabase(db, backupPath);
    const copy = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || copy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup verification failed; original data retained.');
      for (const table of ['users', 'projects', 'tasks', ...lifecycleTables]) {
        const sql = `SELECT * FROM ${table} ORDER BY rowid`;
        if (JSON.stringify(copy.prepare(sql).all()) !== JSON.stringify(db.prepare(sql).all())) throw new Error('Backup differs; original data retained.');
      }
    } finally { copy.close(); }
    transaction(db, () => {
      for (const table of lifecycleTables) db.exec(`DELETE FROM ${table}`);
      db.exec('DELETE FROM tasks; DELETE FROM projects; DELETE FROM users;');
      seedRows(db);
      seedLifecycle(db);
    });
    return backupPath;
  } finally { db?.close(); release(); }
}

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new AppError(400, 'Use only the supported fields.');
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string') throw new AppError(400, `${label} must be text.`);
  const result = required ? value.trim() : value;
  if ((required && !result) || result.length > max) throw new AppError(400, `${label} must be ${required ? '1' : '0'}–${max} characters.`);
  return result;
}
const projectColumns = 'id, name, created_at AS createdAt, updated_at AS updatedAt';
const taskColumns = 'id, project_id AS projectId, title, notes, status, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt';

export function taskService(db) {
  function project(owner, id) {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE owner_id = ? AND id = ?`).get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  function task(owner, id) {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE owner_id = ? AND id = ?`).get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  return {
    listProjects: owner => db.prepare(`SELECT ${projectColumns} FROM projects WHERE owner_id = ? ORDER BY created_at, id`).all(owner),
    createProject(owner, input) {
      fields(input, ['name']);
      const name = text(input.name, 'Project name', 80), id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(id, owner, name, now, now);
      return project(owner, id);
    },
    renameProject(owner, id, input) {
      fields(input, ['name']);
      project(owner, id);
      db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE owner_id = ? AND id = ?').run(text(input.name, 'Project name', 80), new Date().toISOString(), owner, id);
      return project(owner, id);
    },
    listTasks(owner, id) { project(owner, id); return db.prepare(`SELECT ${taskColumns} FROM tasks WHERE owner_id = ? AND project_id = ? ORDER BY created_at, id`).all(owner, id); },
    getTask: task,
    createTask(owner, input) {
      fields(input, ['projectId', 'title', 'notes']);
      if (typeof input.projectId !== 'string') throw new AppError(400, 'Choose a project.');
      project(owner, input.projectId);
      const title = text(input.title, 'Task title', 120), notes = text(input.notes ?? '', 'Notes', 4000, false), id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, owner, input.projectId, title, notes, 'open', now, now, null);
      return task(owner, id);
    },
    editTask(owner, id, input) {
      fields(input, ['title', 'notes']);
      task(owner, id);
      db.prepare('UPDATE tasks SET title = ?, notes = ?, updated_at = ? WHERE owner_id = ? AND id = ?').run(text(input.title, 'Task title', 120), text(input.notes, 'Notes', 4000, false), new Date().toISOString(), owner, id);
      return task(owner, id);
    },
    completeTask(owner, id) {
      task(owner, id);
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'open'").run(now, now, owner, id);
      return task(owner, id);
    },
  };
}
