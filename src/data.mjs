import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadCatalog, loadHost, digest, json, TASK_HOOK, taskDefinitionIds } from './extension-catalog.mjs';
import { taskEffectProofMatches } from './task-effect-simulation.mjs';

const lifecycleTables = ['extension_conversation_links', 'extension_approvals', 'extension_evidence', 'extension_history', 'extension_selections',
  'extension_authored', 'extension_revision_links', 'extensions', 'extension_revisions'];
const authoringHistoryTables = ['authoring_dispatches', 'authoring_messages', 'authoring_operations'];
const taskEffectTables = ['task_effect_receipts', 'task_completion_events'];
function seedLifecycle(db) {
  let catalog = [];
  try { catalog = loadCatalog(); } catch { /* Invalid deployment leaves native tasks usable with no advice. */ }
  const scoped = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extensions'").get();
  const hookScoped = db.prepare('PRAGMA table_info(extension_selections)').all().some(column => column.name === 'hook_id');
  for (const user of USERS) {
    if (!scoped) db.prepare('INSERT INTO extension_states VALUES (?, 0, NULL)').run(user.id);
    const template = catalog.find(item => item.id === (user.id === 'maya' ? 'pending' : user.id === 'leo' ? 'attention' : ''));
    const revisionId = template ? randomUUID() : null;
    if (template) {
      db.prepare('INSERT INTO extension_revisions VALUES (?, ?, ?, ?, ?)').run(revisionId, user.id, template.id, template.identity, 'operator');
      if (scoped) {
        const extensionId = randomUUID();
        db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,creation_operation_id,creation_hash,draft_version,draft_revision_id) VALUES (?,?,?,?,?,NULL,NULL,0,NULL)').run(extensionId, user.id, 'ClassifyTask', 'Task advice (saved setup)', Date.now());
        db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, user.id, extensionId);
      }
    }
    if (hookScoped) {
      db.prepare("INSERT INTO extension_selections(owner_id,hook_id,revision_id,generation) VALUES (?,'ClassifyTask',?,?)").run(user.id, revisionId, template ? 1 : 0);
      db.prepare("INSERT INTO extension_selections(owner_id,hook_id,revision_id,generation) VALUES (?,'TaskCompleted',NULL,0)").run(user.id);
    } else db.prepare('INSERT INTO extension_selections VALUES (?, ?, ?)').run(user.id, revisionId, template ? 1 : 0);
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

function migrateAuthored(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE extension_authored(
      revision_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
      source BLOB NOT NULL CHECK(length(source) BETWEEN 1 AND 65536),
      artifact BLOB NOT NULL CHECK(length(artifact) BETWEEN 1 AND 1048576),
      suite TEXT CHECK(suite IS NULL OR length(CAST(suite AS BLOB))<=131072),
      FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
      PRAGMA user_version = 3;`);
  });
}

function migrateAuthoring(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE authoring_budget(id INTEGER PRIMARY KEY CHECK(id=1),
        reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 0 AND 9007199254740991)) STRICT;
      INSERT INTO authoring_budget VALUES (1, 0);
      CREATE TABLE authoring_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        creation_operation_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
        run_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('IDLE','RUNNING','CANCELLING','AWAITING_USER','REVIEW_AVAILABLE','CANCELLED','BLOCKED','INTERRUPTED')),
        cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
        state TEXT NOT NULL, operations TEXT NOT NULL, view TEXT NOT NULL, UNIQUE(id,owner_id), UNIQUE(owner_id,creation_operation_id),
        CHECK(length(CAST(state AS BLOB))+length(CAST(operations AS BLOB))+length(CAST(view AS BLOB))<=262144),
        CHECK(length(CAST(view AS BLOB))<=131072), CHECK(length(CAST(operations AS BLOB))<=16384)) STRICT;
      CREATE INDEX authoring_conversations_owner ON authoring_conversations(owner_id,updated_at);
      PRAGMA user_version = 4;
    `);
  });
}

function migrateExtensions(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE extensions(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80), created_at INTEGER NOT NULL CHECK(created_at>=0),
        creation_operation_id TEXT, creation_hash TEXT, draft_version INTEGER NOT NULL CHECK(draft_version>=0), draft_revision_id TEXT,
        UNIQUE(id,owner_id), UNIQUE(owner_id,creation_operation_id),
        FOREIGN KEY(draft_revision_id,owner_id,id) REFERENCES extension_revision_links(revision_id,owner_id,extension_id)
      ) STRICT;
      CREATE TABLE extension_revision_links(
        revision_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, extension_id TEXT NOT NULL,
        UNIQUE(revision_id,owner_id,extension_id),
        FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
        FOREIGN KEY(extension_id,owner_id) REFERENCES extensions(id,owner_id)
      ) STRICT;
      CREATE TABLE extension_conversation_links(
        conversation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, extension_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('CREATE','REVISE')), base_revision_id TEXT, base_generation INTEGER,
        FOREIGN KEY(conversation_id,owner_id) REFERENCES authoring_conversations(id,owner_id),
        FOREIGN KEY(extension_id,owner_id) REFERENCES extensions(id,owner_id),
        FOREIGN KEY(base_revision_id,owner_id,extension_id) REFERENCES extension_revision_links(revision_id,owner_id,extension_id)
      ) STRICT;
      CREATE INDEX extension_items_owner ON extensions(owner_id,created_at);
      CREATE INDEX extension_revisions_item ON extension_revision_links(owner_id,extension_id);
      CREATE INDEX extension_conversations_item ON extension_conversation_links(owner_id,extension_id);
    `);
    for (const state of db.prepare('SELECT * FROM extension_states').all()) {
      const revisions = db.prepare('SELECT id FROM extension_revisions WHERE owner_id=?').all(state.owner_id);
      if (!revisions.length) {
        if (state.draft_id) throw new Error('Invalid legacy draft lineage');
        continue;
      }
      const id = randomUUID();
      db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,creation_operation_id,creation_hash,draft_version,draft_revision_id) VALUES (?,?,?,?,?,NULL,NULL,0,NULL)').run(id, state.owner_id, 'ClassifyTask', 'Task advice (saved setup)', Date.now());
      for (const row of revisions) db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(row.id, state.owner_id, id);
      db.prepare('UPDATE extensions SET draft_version=?,draft_revision_id=? WHERE id=?').run(state.draft_version, state.draft_id, id);
    }
    for (const row of db.prepare('SELECT * FROM authoring_conversations').all()) {
      let state, view;
      try { state = JSON.parse(row.state); view = JSON.parse(row.view); } catch { continue; }
      const ids = [state.handles?.revisionId, state.evidenceHandle?.revisionId, view.review?.revisionId].filter(value => value !== null && value !== undefined);
      if (!ids.length || ids.some(id => typeof id !== 'string')) continue;
      const links = ids.map(id => db.prepare('SELECT extension_id FROM extension_revision_links WHERE owner_id=? AND revision_id=?').get(row.owner_id, id));
      if (links.some(link => !link) || new Set(links.map(link => link.extension_id)).size !== 1) continue;
      const proofs = [state.evidenceHandle, view.review].filter(value => value?.evidenceId);
      if (proofs.some(proof => !db.prepare('SELECT 1 FROM extension_evidence WHERE owner_id=? AND id=? AND revision_id=?').get(row.owner_id, proof.evidenceId, proof.revisionId))) continue;
      db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,NULL)').run(row.id, row.owner_id, links[0].extension_id, 'REVISE', ids[0]);
    }
    db.exec('DROP TABLE extension_states');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Extension migration failed integrity checks');
    db.exec('PRAGMA user_version = 5');
  });
}

function migrateAuthoringHistory(db) {
  // Rebuilding adds a required timestamp without inventing a default for old rows.
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    transaction(db, () => {
      db.exec(`CREATE TABLE authoring_conversations_v6(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        creation_operation_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
        run_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('IDLE','RUNNING','CANCELLING','AWAITING_USER','REVIEW_AVAILABLE','CANCELLED','BLOCKED','INTERRUPTED')),
        cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
        state TEXT NOT NULL, operations TEXT NOT NULL, view TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
        UNIQUE(id,owner_id), UNIQUE(owner_id,creation_operation_id),
        CHECK(length(CAST(state AS BLOB))+length(CAST(operations AS BLOB))+length(CAST(view AS BLOB))<=262144),
        CHECK(length(CAST(view AS BLOB))<=131072), CHECK(length(CAST(operations AS BLOB))<=16384)) STRICT;
        CREATE TABLE authoring_messages(conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991), message_id TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=131072),
          PRIMARY KEY(conversation_id,sequence), UNIQUE(conversation_id,message_id),
          FOREIGN KEY(conversation_id,owner_id) REFERENCES authoring_conversations(id,owner_id)) STRICT;
        CREATE TABLE authoring_operations(conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL, operation_id TEXT NOT NULL,
          body_hash TEXT NOT NULL, run_id TEXT NOT NULL, admitted_version INTEGER NOT NULL CHECK(admitted_version BETWEEN 0 AND 9007199254740991),
          PRIMARY KEY(conversation_id,operation_id), UNIQUE(conversation_id,owner_id,run_id),
          FOREIGN KEY(conversation_id,owner_id) REFERENCES authoring_conversations(id,owner_id)) STRICT;
        CREATE TABLE authoring_dispatches(conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL, run_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9007199254740991), kind TEXT NOT NULL CHECK(kind IN ('provider','tool')),
          call_id TEXT, reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 0 AND 9007199254740991),
          outcome TEXT CHECK(outcome IN ('SUCCESS','REJECTED','UNKNOWN')),
          PRIMARY KEY(conversation_id,run_id,ordinal), UNIQUE(conversation_id,run_id,call_id),
          FOREIGN KEY(conversation_id,owner_id,run_id) REFERENCES authoring_operations(conversation_id,owner_id,run_id)) STRICT;`);
      const insertMessage = db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)');
      const insertOperation = db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)');
      const insertDispatch = db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)');
      for (const row of db.prepare('SELECT * FROM authoring_conversations ORDER BY rowid').all()) {
        const state = JSON.parse(row.state), operations = JSON.parse(row.operations), view = JSON.parse(row.view);
        if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isSafeInteger(state.createdAt) || state.createdAt < 0
            || !Array.isArray(operations) || !view || typeof view !== 'object' || Array.isArray(view) || !Array.isArray(view.messages)
            || state.journal !== undefined && !Array.isArray(state.journal)) throw new Error('Invalid legacy authoring history; no data was reset.');
        for (const [index, value] of view.messages.entries()) {
          if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string') throw new Error('Invalid legacy authoring message.');
          insertMessage.run(row.id, row.owner_id, index + 1, value.id, JSON.stringify(value));
        }
        for (const item of operations) insertOperation.run(row.id, row.owner_id, item.id, item.hash, item.runId, item.version);
        for (const item of state.journal ?? []) insertDispatch.run(row.id, row.owner_id, item.runId, item.ordinal,
          item.kind, item.callId ?? null, item.reservedMicros, item.outcome ?? null);
        delete state.journal; delete state.inputIds; delete state.callIds;
        view.messages = [];
        db.prepare('INSERT INTO authoring_conversations_v6 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.owner_id,
          row.creation_operation_id, row.version, row.run_id, row.status, row.cancel_requested, row.updated_at,
          JSON.stringify(state), JSON.stringify(operations.slice(-1)), JSON.stringify(view), state.createdAt);
      }
      db.exec(`DROP TABLE authoring_conversations;
        ALTER TABLE authoring_conversations_v6 RENAME TO authoring_conversations;
        CREATE INDEX authoring_conversations_owner ON authoring_conversations(owner_id,created_at,id);
        CREATE TRIGGER authoring_created_at_immutable BEFORE UPDATE OF created_at ON authoring_conversations
          WHEN NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'Authoring creation time is immutable'); END;
        CREATE TRIGGER authoring_dispatch_immutable BEFORE UPDATE ON authoring_dispatches
          WHEN OLD.outcome IS NOT NULL OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.owner_id IS NOT OLD.owner_id
            OR NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind
            OR NEW.call_id IS NOT OLD.call_id OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.outcome IS NULL
          BEGIN SELECT RAISE(ABORT, 'Authoring dispatch is immutable'); END;`);
      if (db.prepare('PRAGMA foreign_key_check').all().length || db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Authoring migration failed integrity checks');
      db.exec('PRAGMA user_version=6');
    });
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Foreign keys are required.');
  }
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

function migrateTaskEffects(db) {
  transaction(db, () => {
    db.exec(`
      CREATE UNIQUE INDEX tasks_owner ON tasks(id,owner_id);
      CREATE TABLE extension_selections_v8(
        owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT NOT NULL CHECK(hook_id IN ('ClassifyTask','TaskCompleted')),
        revision_id TEXT, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
        binding_pins TEXT CHECK(binding_pins IS NULL OR length(CAST(binding_pins AS BLOB))<=32768),
        PRIMARY KEY(owner_id,hook_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
        CHECK(revision_id IS NOT NULL OR binding_pins IS NULL)) STRICT;
      INSERT INTO extension_selections_v8(owner_id,hook_id,revision_id,generation)
        SELECT owner_id,'ClassifyTask',revision_id,generation FROM extension_selections;
      INSERT INTO extension_selections_v8(owner_id,hook_id,revision_id,generation) SELECT id,'TaskCompleted',NULL,0 FROM users;
      DROP TABLE extension_selections;
      ALTER TABLE extension_selections_v8 RENAME TO extension_selections;
      CREATE TABLE task_completion_events(
        event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), source_task_id TEXT NOT NULL UNIQUE,
        original_key TEXT NOT NULL UNIQUE CHECK(length(original_key)=36), item_id TEXT, revision_id TEXT,
        selection_generation INTEGER NOT NULL CHECK(selection_generation BETWEEN 0 AND 9007199254740991),
        input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB))<=4096),
        pins TEXT CHECK(pins IS NULL OR length(CAST(pins AS BLOB))<=32768),
        state TEXT NOT NULL CHECK(state IN ('NO_BINDING','PENDING','STARTED','FINISHED')),
        revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=0),
        outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=131072)),
        reconciliation TEXT CHECK(reconciliation IS NULL OR (json_valid(reconciliation) AND length(CAST(reconciliation AS BLOB))<=32768)),
        created_at TEXT NOT NULL, UNIQUE(owner_id,original_key),
        FOREIGN KEY(source_task_id,owner_id) REFERENCES tasks(id,owner_id),
        FOREIGN KEY(revision_id,owner_id,item_id) REFERENCES extension_revision_links(revision_id,owner_id,extension_id),
        CHECK((state='NO_BINDING' AND revision_id IS NULL) OR (state!='NO_BINDING' AND revision_id IS NOT NULL)),
        CHECK((state='FINISHED' AND outcome IS NOT NULL) OR (state!='FINISHED' AND outcome IS NULL))) STRICT;
      CREATE INDEX task_events_item ON task_completion_events(owner_id,item_id,state);
      CREATE TABLE task_effect_receipts(
        owner_id TEXT NOT NULL, capability_id TEXT NOT NULL CHECK(capability_id='tasks.create'), original_key TEXT NOT NULL,
        capability_version TEXT NOT NULL CHECK(capability_version='1'), payload BLOB NOT NULL CHECK(length(payload)<=4096),
        result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=4096), effect TEXT NOT NULL CHECK(effect IN ('CONFIRMED','NONE')),
        created_task_id TEXT, PRIMARY KEY(owner_id,capability_id,original_key),
        FOREIGN KEY(owner_id,original_key) REFERENCES task_completion_events(owner_id,original_key),
        FOREIGN KEY(created_task_id,owner_id) REFERENCES tasks(id,owner_id),
        CHECK((effect='CONFIRMED' AND created_task_id IS NOT NULL) OR (effect='NONE' AND created_task_id IS NULL))) STRICT;
      CREATE TRIGGER task_event_immutable BEFORE UPDATE ON task_completion_events
        WHEN NEW.event_id IS NOT OLD.event_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.source_task_id IS NOT OLD.source_task_id
          OR NEW.original_key IS NOT OLD.original_key OR NEW.item_id IS NOT OLD.item_id OR NEW.revision_id IS NOT OLD.revision_id
          OR NEW.selection_generation IS NOT OLD.selection_generation OR NEW.input IS NOT OLD.input OR NEW.pins IS NOT OLD.pins
          OR NEW.created_at IS NOT OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
          OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
          OR (NEW.state IS NOT OLD.state AND NOT ((OLD.state='PENDING' AND NEW.state='STARTED') OR (OLD.state='STARTED' AND NEW.state='FINISHED')))
        BEGIN SELECT RAISE(ABORT,'Task event identity and settled outcome are immutable'); END;
      CREATE TRIGGER task_receipt_immutable BEFORE UPDATE ON task_effect_receipts
        BEGIN SELECT RAISE(ABORT,'Task effect receipts are immutable'); END;
      PRAGMA user_version=8;
    `);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Task effect migration failed integrity checks');
  });
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
    } else if (![1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error('Unsupported database version; no data was reset.');
    if (version < 2) migrateLifecycle(db);
    if (version < 3) migrateAuthored(db);
    if (version < 4) migrateAuthoring(db);
    if (version < 5) migrateExtensions(db);
    if (version < 6) migrateAuthoringHistory(db);
    if (version < 7) transaction(db, () => {
      db.exec('ALTER TABLE extensions ADD COLUMN deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at>=0); PRAGMA user_version=7;');
    });
    if (version < 8) migrateTaskEffects(db);
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
      for (const table of ['users', 'projects', 'tasks', ...taskEffectTables, ...lifecycleTables, ...authoringHistoryTables, 'authoring_conversations', 'authoring_budget']) {
        // Read text as bytes because SQLite's Node text reader can stop at embedded NUL.
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name, type }) => type === 'TEXT' ? `CAST(${name} AS BLOB) AS ${name}` : name);
        const sql = `SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`;
        if (JSON.stringify(copy.prepare(sql).all()) !== JSON.stringify(db.prepare(sql).all())) throw new Error('Backup differs; original data retained.');
      }
    } finally { copy.close(); }
    transaction(db, () => {
      for (const table of taskEffectTables) db.exec(`DELETE FROM ${table}`);
      db.exec('UPDATE extensions SET draft_revision_id=NULL');
      for (const table of authoringHistoryTables) db.exec(`DELETE FROM ${table}`);
      for (const table of lifecycleTables) db.exec(`DELETE FROM ${table}`);
      db.exec('DELETE FROM authoring_conversations');
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

function insertTask(db, owner, projectId, title, notes) {
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, owner, projectId, title, notes, 'open', now, now, null);
  return id;
}

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
    getTaskForCustomization(owner, id) {
      // SQLite TEXT reads stop at embedded NUL; the model must see the saved title without truncation.
      const row = db.prepare('SELECT id, project_id AS projectId, status, CAST(title AS BLOB) AS title FROM tasks WHERE owner_id=? AND id=?').get(owner, id);
      if (!row) throw notFound();
      return { ...row, title: Buffer.from(row.title).toString('utf8') };
    },
    createTask(owner, input) {
      fields(input, ['projectId', 'title', 'notes']);
      if (typeof input.projectId !== 'string') throw new AppError(400, 'Choose a project.');
      project(owner, input.projectId);
      const title = text(input.title, 'Task title', 120), notes = text(input.notes ?? '', 'Notes', 4000, false);
      const id = insertTask(db, owner, input.projectId, title, notes);
      return task(owner, id);
    },
    editTask(owner, id, input) {
      fields(input, ['title', 'notes']);
      task(owner, id);
      db.prepare('UPDATE tasks SET title = ?, notes = ?, updated_at = ? WHERE owner_id = ? AND id = ?').run(text(input.title, 'Task title', 120), text(input.notes, 'Notes', 4000, false), new Date().toISOString(), owner, id);
      return task(owner, id);
    },
    completeTask(owner, id) {
      return transaction(db, () => {
        task(owner, id);
        const now = new Date().toISOString();
        const changed = db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'open'").run(now, now, owner, id).changes;
        if (changed) {
          const selected = db.prepare("SELECT s.*,l.extension_id FROM extension_selections s LEFT JOIN extension_revision_links l ON l.revision_id=s.revision_id AND l.owner_id=s.owner_id WHERE s.owner_id=? AND s.hook_id='TaskCompleted'").get(owner);
          db.prepare(`INSERT INTO task_completion_events(event_id,owner_id,source_task_id,original_key,item_id,revision_id,selection_generation,input,pins,state,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), owner, id, randomUUID(), selected?.extension_id ?? null,
            selected?.revision_id ?? null, selected?.generation ?? 0, JSON.stringify({ taskId: id }), selected?.binding_pins ?? null,
            selected?.revision_id ? 'PENDING' : 'NO_BINDING', now);
        }
        return task(owner, id);
      });
    },
  };
}

// Called inside the lifecycle transaction; revocation never erases settled native evidence.
export function revokeTaskAdmissions(db, owner, itemId) {
  db.prepare("UPDATE task_completion_events SET revoked_at=? WHERE owner_id=? AND item_id=? AND state IN ('PENDING','STARTED') AND revoked_at IS NULL")
    .run(Date.now(), owner, itemId);
  db.prepare(`UPDATE extension_selections SET revision_id=NULL,binding_pins=NULL,generation=generation+1
    WHERE owner_id=? AND hook_id='TaskCompleted' AND revision_id IN
      (SELECT revision_id FROM extension_revision_links WHERE owner_id=? AND extension_id=?)`).run(owner, owner, itemId);
}

const nativeKeys = new WeakMap();
const effectError = (code, status = 403) => Object.assign(new AppError(status, code), { code });
function storedJson(value, max) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw effectError('INPUT_INVALID', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof encoded !== 'string' || Buffer.byteLength(encoded) > max)
    throw effectError('INPUT_INVALID', 400);
  return encoded;
}
function freezeContext(value) {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (next && typeof next === 'object' && !Object.isFrozen(next)) { pending.push(...Object.values(next)); Object.freeze(next); }
  }
  return value;
}
function taskEvent(row) {
  const parse = value => { try { return JSON.parse(value); } catch { return null; } };
  return freezeContext({ eventId: row.event_id, owner: row.owner_id, sourceTaskId: row.source_task_id, originalKey: row.original_key,
    itemId: row.item_id, revisionId: row.revision_id, selectionGeneration: row.selection_generation,
    input: parse(row.input), pins: parse(row.pins), state: row.state, revokedAt: row.revoked_at,
    outcome: parse(row.outcome), reconciliation: parse(row.reconciliation) });
}

// Native storage owns key authenticity, current resource access and atomic task/receipt writes.
export function taskEffectService(db) {
  if (arguments.length !== 1 || typeof db?.prepare !== 'function') throw new TypeError('Task effects require one native database.');
  const tasks = taskService(db);
  const hostPins = new Map();
  for (const id of taskDefinitionIds) {
    try { hostPins.set(id, Object.entries(loadHost(TASK_HOOK, id).pins)); }
    catch { /* Unavailable definitions cannot authorize native effects. */ }
  }
  const event = (owner, id) => {
    const row = db.prepare('SELECT * FROM task_completion_events WHERE owner_id=? AND event_id=?').get(owner, id);
    if (!row) throw notFound();
    return row;
  };
  const receipt = row => db.prepare("SELECT * FROM task_effect_receipts WHERE owner_id=? AND capability_id='tasks.create' AND original_key=?").get(row.owner_id, row.original_key);
  const canRead = context => tasks.getTask(context.owner, context.sourceTaskId);
  function current(row, invocation) {
    try {
      const context = contextFor(row.owner_id, invocation), pins = context.pins;
      const now = invocation.deadline.clock.nowMs();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(invocation.deadline.expiresAtMs)
          || now >= invocation.deadline.expiresAtMs || context.eventId !== row.event_id || row.revoked_at !== null
          || pins?.profile !== 'keir-effect/4'
          || pins.modelRef?.format !== 'keir-dcm/effect-4' || pins.modelRef.digest !== pins.modelDigest
          || pins.consumer?.kind !== 'EVENT_REPORT' || Object.hasOwn(pins, 'qualification')
          || context.input?.taskId !== row.source_task_id) return false;
      const expected = hostPins.get(pins.definitionId);
      if (!expected || expected.some(([name, value]) => json(pins[name]) !== json(value))) return false;
      // Re-read persisted authority; a mutable current selection cannot replace the captured admission.
      const saved = db.prepare(`SELECT r.*,a.source,a.artifact,a.suite FROM task_completion_events v JOIN tasks t ON t.id=v.source_task_id AND t.owner_id=v.owner_id
      JOIN extension_revision_links l ON l.revision_id=v.revision_id AND l.owner_id=v.owner_id AND l.extension_id=v.item_id
      JOIN extensions e ON e.id=l.extension_id AND e.owner_id=l.owner_id
      JOIN extension_revisions r ON r.id=l.revision_id AND r.owner_id=l.owner_id
      JOIN extension_authored a ON a.revision_id=r.id AND a.owner_id=r.owner_id
      WHERE v.event_id=? AND v.owner_id=? AND v.revoked_at IS NULL AND e.deleted_at IS NULL AND t.status='completed'
        AND e.hook_id='TaskCompleted' AND r.provenance='customer'`).get(row.event_id, row.owner_id);
      if (!saved) return false;
      const identity = JSON.parse(saved.identity), artifact = JSON.parse(Buffer.from(saved.artifact).toString('utf8'));
      if (json(pins) !== json({ ...identity, approvedEvidenceId: pins.approvedEvidenceId })
          || identity.artifactDigest !== digest(saved.artifact) || identity.rawSourceDigest !== digest(saved.source)
          || artifact.profile !== 'keir-effect/4' || artifact.format !== 'keir-artifact/effect-4'
          || identity.compiledSourceDigest !== artifact.sourceDigest || identity.suiteDigest !== digest(saved.suite)) return false;
      const validProof = id => {
        const proof = db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND revision_id=? AND id=?').get(row.owner_id, saved.id, id);
        return taskEffectProofMatches(saved, saved, proof);
      };
      const approval = db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(row.owner_id, saved.id);
      return !!approval && validProof(approval.evidence_id) && typeof pins.approvedEvidenceId === 'string' && validProof(pins.approvedEvidenceId);
    } catch { return false; }
  }
  function deny(row) {
    db.prepare('UPDATE task_completion_events SET revoked_at=? WHERE event_id=? AND owner_id=? AND revoked_at IS NULL')
      .run(Date.now(), row.event_id, row.owner_id);
    return effectError('AUTHORITY_DENIED');
  }
  function fromKey(owner, key) {
    const identity = key && typeof key === 'object' ? nativeKeys.get(key) : null;
    if (!identity || identity.db !== db || identity.owner !== owner) throw effectError('HOST_KEY_INVALID', 400);
    const row = event(owner, identity.eventId);
    if (row.original_key !== identity.originalKey) throw effectError('HOST_KEY_INVALID', 400);
    return row;
  }
  function contextFor(owner, invocation) {
    const row = fromKey(owner, invocation?.requestKey);
    if (invocation?.event?.id !== row.event_id || invocation?.event?.source !== row.source_task_id)
      throw effectError('HOST_CONTEXT_INVALID', 400);
    canRead(taskEvent(row));
    return taskEvent(row);
  }
  const resultOf = row => row ? JSON.parse(row.result) : null;
  return {
    keyFor(owner, eventId) {
      const row = event(owner, eventId); canRead(taskEvent(row));
      const key = Object.freeze({ type: 'demo.TaskCompletionKey/1', value: row.original_key });
      nativeKeys.set(key, { db, owner, eventId, originalKey: row.original_key });
      return key;
    },
    contextFor,
    claim(owner, eventId, invocation) {
      const result = transaction(db, () => {
        const row = event(owner, eventId);
        if (row.state !== 'PENDING') return null;
        if (!current(row, invocation)) return deny(row);
        db.prepare("UPDATE task_completion_events SET state='STARTED' WHERE owner_id=? AND event_id=? AND state='PENDING'").run(owner, eventId);
        const claimed = event(owner, eventId);
        if (claimed.state !== 'STARTED' || !current(claimed, invocation)) return deny(row);
        return taskEvent(claimed);
      });
      if (result instanceof Error) throw result;
      return result;
    },
    createTaskOnce(owner, key, input, invocation) {
      const result = transaction(db, () => {
        const row = fromKey(owner, key);
        fields(input, ['projectId', 'title']);
        if (typeof input.projectId !== 'string' || !input.projectId.isWellFormed()
            || typeof input.title !== 'string' || !input.title.isWellFormed()) throw effectError('INPUT_INVALID', 400);
        const title = text(input.title, 'Task title', 120), payload = Buffer.from(JSON.stringify({ projectId: input.projectId, title }));
        const prior = receipt(row);
        if (prior) {
          canRead(freezeContext({ ...taskEvent(row), projectId: input.projectId }));
          if (prior.capability_version !== '1' || !Buffer.from(prior.payload).equals(payload))
            return { kind: 'BUSINESS_REJECTION', code: 'KEY_PAYLOAD_MISMATCH', effect: 'NONE' };
          return resultOf(prior);
        }
        if (row.state !== 'STARTED') throw effectError('EVENT_NOT_STARTED', 409);
        if (invocation?.requestKey !== key || !current(row, invocation)) return deny(row);
        // A savepoint keeps durable revocation while rolling back an uncommitted task and receipt.
        db.exec('SAVEPOINT task_effect_create');
        const project = db.prepare('SELECT 1 FROM projects WHERE owner_id=? AND id=?').get(owner, input.projectId);
        const id = project ? insertTask(db, owner, input.projectId, title, '') : null;
        const response = id ? { kind: 'SUCCESS', value: { id }, effect: 'CONFIRMED' }
          : { kind: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND', effect: 'NONE' };
        db.prepare('INSERT INTO task_effect_receipts VALUES (?,?,?,?,?,?,?,?)')
          .run(owner, 'tasks.create', row.original_key, '1', payload, JSON.stringify(response), response.effect, id);
        const after = event(owner, row.event_id);
        if (after.state !== 'STARTED' || !current(after, invocation)) {
          db.exec('ROLLBACK TO task_effect_create; RELEASE task_effect_create');
          return deny(row);
        }
        db.exec('RELEASE task_effect_create');
        return response;
      });
      if (result instanceof Error) throw result;
      return result;
    },
    finish(owner, eventId, outcome) {
      const encoded = storedJson(outcome, 131072);
      return transaction(db, () => {
        const row = event(owner, eventId);
        if (row.state === 'FINISHED') {
          if (row.outcome !== encoded) throw effectError('OUTCOME_IMMUTABLE', 409);
          return false;
        }
        if (row.state !== 'STARTED') throw effectError('EVENT_NOT_STARTED', 409);
        db.prepare("UPDATE task_completion_events SET state='FINISHED',outcome=? WHERE owner_id=? AND event_id=?").run(encoded, owner, eventId);
        return true;
      });
    },
    status(owner, eventId) {
      const row = event(owner, eventId); canRead(taskEvent(row));
      return { ...taskEvent(row), receipt: resultOf(receipt(row)) };
    },
    reconcile(owner, eventId) {
      return transaction(db, () => {
        const row = event(owner, eventId); canRead(taskEvent(row));
        const observation = { observedAt: new Date().toISOString(), receipt: resultOf(receipt(row)) };
        db.prepare('UPDATE task_completion_events SET reconciliation=? WHERE owner_id=? AND event_id=?').run(JSON.stringify(observation), owner, eventId);
        return observation;
      });
    },
  };
}
