import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, readSync,
  lstatSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { loadHost, definitionForPins, digest, json, TASK_HOOK } from './extension-catalog.mjs';
import { taskEffectProofMatches } from './task-effect-simulation.mjs';
import { normalizeTaskTag, normalizeTaskTags, parseWorkflowTagsText, validOpenMatchInput, normalizeWorkflowTitle } from './task-workflow-values.mjs';

const lifecycleTables = ['extension_conversation_links', 'extension_approvals', 'extension_evidence', 'extension_history', 'extension_selections',
  'legacy_extension_selections', 'extension_authored', 'extension_revision_links', 'extensions', 'extension_revisions'];
const authoringHistoryTables = ['authoring_dispatches', 'authoring_messages', 'authoring_operations'];
const taskEffectTables = ['task_create_operations', 'task_effect_receipts', 'task_events'];
const createdHook = 'TaskCreated';
const schemaVersion = 14;
const addTaskFields = `
  ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high'));
  ALTER TABLE tasks ADD COLUMN due_at TEXT
    CHECK(due_at IS NULL OR (length(due_at)=24 AND due_at>='0001-01-01T00:00:00.000Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',due_at,'+0 seconds') IS due_at));
`;
const schema = `
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
    tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 8),
    FOREIGN KEY(project_id, owner_id) REFERENCES projects(id, owner_id),
    CHECK((status = 'open' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL))
  ) STRICT;
  CREATE INDEX tasks_by_project ON tasks(owner_id, project_id, created_at);
  CREATE UNIQUE INDEX tasks_owner ON tasks(id,owner_id);

  CREATE TABLE extension_revisions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), template_id TEXT NOT NULL,
    identity TEXT NOT NULL, provenance TEXT NOT NULL CHECK(provenance IN ('operator','customer')), UNIQUE(id,owner_id)) STRICT;

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

  CREATE TABLE extension_authored(
    revision_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
    source BLOB NOT NULL CHECK(length(source) BETWEEN 1 AND 65536),
    artifact BLOB NOT NULL CHECK(length(artifact) BETWEEN 1 AND 1048576),
    suite TEXT CHECK(suite IS NULL OR length(CAST(suite AS BLOB))<=131072),
    FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;

  CREATE TABLE authoring_budget(id INTEGER PRIMARY KEY CHECK(id=1),
    reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 0 AND 9007199254740991)) STRICT;

  CREATE TABLE authoring_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
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
    FOREIGN KEY(conversation_id,owner_id,run_id) REFERENCES authoring_operations(conversation_id,owner_id,run_id)) STRICT;

  CREATE INDEX authoring_conversations_owner ON authoring_conversations(owner_id,created_at,id);
  CREATE TRIGGER authoring_created_at_immutable BEFORE UPDATE OF created_at ON authoring_conversations
    WHEN NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'Authoring creation time is immutable'); END;
  CREATE TRIGGER authoring_dispatch_immutable BEFORE UPDATE ON authoring_dispatches
    WHEN OLD.outcome IS NOT NULL OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind
      OR NEW.call_id IS NOT OLD.call_id OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.outcome IS NULL
    BEGIN SELECT RAISE(ABORT, 'Authoring dispatch is immutable'); END;

  CREATE TABLE extensions(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80), created_at INTEGER NOT NULL CHECK(created_at>=0),
    creation_operation_id TEXT, creation_hash TEXT, draft_version INTEGER NOT NULL CHECK(draft_version>=0), draft_revision_id TEXT,
    deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at>=0),
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

  CREATE TABLE extension_selections(
    owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT NOT NULL CHECK(hook_id='TaskCompleted'),
    revision_id TEXT, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    binding_pins TEXT CHECK(binding_pins IS NULL OR length(CAST(binding_pins AS BLOB))<=32768),
    PRIMARY KEY(owner_id,hook_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
    CHECK(revision_id IS NOT NULL OR binding_pins IS NULL)) STRICT;

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
`;

// Keep the shipped schema above exact for v10 and v11 admission.
const rebuildTaskWorkflow = `
  ALTER TABLE extension_selections RENAME TO previous_selections;
  CREATE TABLE extension_selections(
    owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT NOT NULL CHECK(hook_id IN ('TaskCreated','TaskCompleted')),
    revision_id TEXT, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    binding_pins TEXT CHECK(binding_pins IS NULL OR length(CAST(binding_pins AS BLOB))<=32768),
    PRIMARY KEY(owner_id,hook_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
    CHECK(revision_id IS NOT NULL OR binding_pins IS NULL)) STRICT;
  INSERT INTO extension_selections(rowid,owner_id,hook_id,revision_id,generation,binding_pins)
    SELECT rowid,owner_id,hook_id,revision_id,generation,binding_pins FROM previous_selections;
  INSERT INTO extension_selections(owner_id,hook_id,generation) SELECT id,'TaskCreated',0 FROM users;
  DROP TABLE previous_selections;

  CREATE TABLE task_events(
    event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), source_task_id TEXT NOT NULL,
    hook_id TEXT NOT NULL CHECK(hook_id IN ('TaskCreated','TaskCompleted')),
    original_key TEXT NOT NULL UNIQUE CHECK(length(original_key)=36), item_id TEXT, revision_id TEXT,
    selection_generation INTEGER NOT NULL CHECK(selection_generation BETWEEN 0 AND 9007199254740991),
    input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB))<=4096),
    pins TEXT CHECK(pins IS NULL OR length(CAST(pins AS BLOB))<=32768),
    state TEXT NOT NULL CHECK(state IN ('NO_BINDING','PENDING','STARTED','FINISHED')),
    revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=0),
    outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=131072)),
    reconciliation TEXT CHECK(reconciliation IS NULL OR (json_valid(reconciliation) AND length(CAST(reconciliation AS BLOB))<=32768)),
    created_at TEXT NOT NULL, UNIQUE(owner_id,original_key), UNIQUE(owner_id,hook_id,source_task_id),
    FOREIGN KEY(source_task_id,owner_id) REFERENCES tasks(id,owner_id),
    FOREIGN KEY(revision_id,owner_id,item_id) REFERENCES extension_revision_links(revision_id,owner_id,extension_id),
    CHECK((state='NO_BINDING' AND revision_id IS NULL) OR (state!='NO_BINDING' AND revision_id IS NOT NULL)),
    CHECK((state='FINISHED' AND outcome IS NOT NULL) OR (state!='FINISHED' AND outcome IS NULL))) STRICT;
  INSERT INTO task_events(rowid,event_id,owner_id,source_task_id,hook_id,original_key,item_id,revision_id,selection_generation,
    input,pins,state,revoked_at,outcome,reconciliation,created_at)
    SELECT rowid,event_id,owner_id,source_task_id,'TaskCompleted',original_key,item_id,revision_id,selection_generation,
      input,pins,state,revoked_at,outcome,reconciliation,created_at FROM task_completion_events;

  ALTER TABLE task_effect_receipts RENAME TO previous_receipts;
  CREATE TABLE task_effect_receipts(
    owner_id TEXT NOT NULL, capability_id TEXT NOT NULL CHECK(capability_id IN ('tasks.create','tasks.update')), original_key TEXT NOT NULL,
    capability_version TEXT NOT NULL CHECK(capability_version='1'), payload BLOB NOT NULL CHECK(length(payload)<=4096),
    result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=4096), effect TEXT NOT NULL CHECK(effect IN ('CONFIRMED','NONE')),
    affected_task_id TEXT, PRIMARY KEY(owner_id,original_key),
    FOREIGN KEY(owner_id,original_key) REFERENCES task_events(owner_id,original_key),
    FOREIGN KEY(affected_task_id,owner_id) REFERENCES tasks(id,owner_id),
    CHECK((effect='CONFIRMED' AND affected_task_id IS NOT NULL) OR (effect='NONE' AND affected_task_id IS NULL))) STRICT;
  INSERT INTO task_effect_receipts(rowid,owner_id,capability_id,original_key,capability_version,payload,result,effect,affected_task_id)
    SELECT rowid,owner_id,capability_id,original_key,capability_version,payload,result,effect,created_task_id FROM previous_receipts;
  DROP TABLE previous_receipts;
  DROP TABLE task_completion_events;
  CREATE INDEX task_events_item ON task_events(owner_id,item_id,state);
  CREATE INDEX tasks_open_exact_title ON tasks(owner_id,project_id,title COLLATE BINARY) WHERE status='open';
  CREATE TRIGGER task_event_immutable BEFORE UPDATE ON task_events
    WHEN NEW.event_id IS NOT OLD.event_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.source_task_id IS NOT OLD.source_task_id
      OR NEW.hook_id IS NOT OLD.hook_id
      OR NEW.original_key IS NOT OLD.original_key OR NEW.item_id IS NOT OLD.item_id OR NEW.revision_id IS NOT OLD.revision_id
      OR NEW.selection_generation IS NOT OLD.selection_generation OR NEW.input IS NOT OLD.input OR NEW.pins IS NOT OLD.pins
      OR NEW.created_at IS NOT OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
      OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
      OR (NEW.state IS NOT OLD.state AND NOT ((OLD.state='PENDING' AND NEW.state='STARTED') OR (OLD.state='STARTED' AND NEW.state='FINISHED')))
    BEGIN SELECT RAISE(ABORT,'Task event identity and settled outcome are immutable'); END;
  CREATE TRIGGER task_receipt_immutable BEFORE UPDATE ON task_effect_receipts
    BEGIN SELECT RAISE(ABORT,'Task effect receipts are immutable'); END;
`;

const cutoverTaskWorkflow = `
  CREATE TABLE legacy_extension_selections(
    owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT NOT NULL CHECK(hook_id IN ('TaskCreated','TaskCompleted')),
    revision_id TEXT, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    binding_pins TEXT CHECK(binding_pins IS NULL OR length(CAST(binding_pins AS BLOB))<=32768),
    PRIMARY KEY(owner_id,hook_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
    CHECK(revision_id IS NOT NULL OR binding_pins IS NULL)) STRICT;
  INSERT INTO legacy_extension_selections(rowid,owner_id,hook_id,revision_id,generation,binding_pins)
    SELECT rowid,owner_id,hook_id,revision_id,generation,binding_pins FROM extension_selections;
  UPDATE extension_selections SET revision_id=NULL,binding_pins=NULL,generation=generation+1;

  ALTER TABLE task_effect_receipts RENAME TO previous_workflow_receipts;
  CREATE TABLE task_effect_receipts(
    owner_id TEXT NOT NULL, capability_id TEXT NOT NULL, original_key TEXT NOT NULL,
    capability_version TEXT NOT NULL CHECK(
      (capability_id='tasks.create' AND capability_version IN ('1','2')) OR
      (capability_id='tasks.update' AND capability_version='1')),
    payload BLOB NOT NULL CHECK(length(payload)<=4096),
    result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=4096),
    effect TEXT NOT NULL CHECK(effect IN ('CONFIRMED','NONE')), affected_task_id TEXT,
    observation TEXT CHECK(observation IS NULL OR (json_valid(observation) AND length(CAST(observation AS BLOB))<=8192)),
    PRIMARY KEY(owner_id,original_key), FOREIGN KEY(owner_id,original_key) REFERENCES task_events(owner_id,original_key),
    FOREIGN KEY(affected_task_id,owner_id) REFERENCES tasks(id,owner_id),
    CHECK((effect='CONFIRMED' AND affected_task_id IS NOT NULL) OR (effect='NONE' AND affected_task_id IS NULL)),
    CHECK(observation IS NULL OR (effect='CONFIRMED' AND (capability_id!='tasks.create' OR capability_version!='1')))) STRICT;
  INSERT INTO task_effect_receipts(rowid,owner_id,capability_id,original_key,capability_version,payload,result,effect,affected_task_id)
    SELECT rowid,owner_id,capability_id,original_key,capability_version,payload,result,effect,affected_task_id FROM previous_workflow_receipts;
  DROP TABLE previous_workflow_receipts;
  CREATE TRIGGER task_receipt_immutable BEFORE UPDATE ON task_effect_receipts
    BEGIN SELECT RAISE(ABORT,'Task effect receipts are immutable'); END;
  CREATE TRIGGER legacy_selection_immutable BEFORE UPDATE ON legacy_extension_selections
    BEGIN SELECT RAISE(ABORT,'Legacy selections are immutable'); END;
`;

const addTaskCreateGuard = `
  ALTER TABLE extension_selections RENAME TO previous_guard_selections;
  CREATE TABLE extension_selections(
    owner_id TEXT NOT NULL REFERENCES users(id), hook_id TEXT NOT NULL CHECK(hook_id IN ('TaskCreated','TaskCompleted','TaskBeforeCreate')),
    revision_id TEXT, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    binding_pins TEXT CHECK(binding_pins IS NULL OR length(CAST(binding_pins AS BLOB))<=32768),
    PRIMARY KEY(owner_id,hook_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id),
    CHECK(revision_id IS NOT NULL OR binding_pins IS NULL)) STRICT;
  INSERT INTO extension_selections(rowid,owner_id,hook_id,revision_id,generation,binding_pins)
    SELECT rowid,owner_id,hook_id,revision_id,generation,binding_pins FROM previous_guard_selections;
  DROP TABLE previous_guard_selections;
  INSERT INTO extension_selections(owner_id,hook_id,generation) SELECT id,'TaskBeforeCreate',0 FROM users;
  ALTER TABLE task_effect_receipts ADD COLUMN guard_details TEXT
    CHECK(guard_details IS NULL OR (json_valid(guard_details) AND length(CAST(guard_details AS BLOB))<=4096));
  CREATE TABLE task_create_operations(
    owner_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    candidate BLOB NOT NULL CHECK(length(candidate)<=65536 AND json_valid(CAST(candidate AS TEXT))),
    result BLOB NOT NULL CHECK(length(result)<=65536 AND json_valid(CAST(result AS TEXT))
      AND json_extract(CAST(result AS TEXT),'$.state') IN ('CREATED','NOT_CREATED')),
    PRIMARY KEY(owner_id,operation_id)) STRICT;
  CREATE TRIGGER task_create_operation_immutable BEFORE UPDATE ON task_create_operations
    BEGIN SELECT RAISE(ABORT,'Task creation results are immutable'); END;
`;

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
    const selection = db.prepare('INSERT INTO extension_selections(owner_id,hook_id,generation) VALUES (?,?,0)');
    selection.run(user.id, TASK_HOOK);
    selection.run(user.id, createdHook);
    selection.run(user.id, 'TaskBeforeCreate');
    const projectId = randomUUID();
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(projectId, user.id, user.project, now, now);
    user.tasks.forEach((title, index) => {
      db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), user.id, projectId, title, '', index === 2 ? 'completed' : 'open', now, now, index === 2 ? now : null);
    });
  }
}

const unsupportedFormat = () => new Error('Unsupported database format; no data was reset.');
const rollbackMagic = Buffer.from('d9d505f920a163d7', 'hex');

function readBytes(path, length, position = 0) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    if (readSync(fd, bytes, 0, length, position) !== length) throw unsupportedFormat();
    return bytes;
  } finally { closeSync(fd); }
}

function supportedVersion(version, allowUpgrade) {
  return version === schemaVersion || allowUpgrade && (version === 10 || version === 11 || version === 12 || version === 13);
}

function inspectDataFile(path, allowUpgrade = false) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  const journal = lstatSync(path + '-journal', { throwIfNoEntry: false });
  if (lstatSync(path + '-wal', { throwIfNoEntry: false }) || lstatSync(path + '-shm', { throwIfNoEntry: false })
      || journal && (!file || !journal.isFile())) throw unsupportedFormat();
  if (!file) return null;
  if (!file.isFile()) throw unsupportedFormat();

  const header = readBytes(path, 100), pageSize = header.readUInt16BE(16);
  if (header.toString('latin1', 0, 16) !== 'SQLite format 3\x00'
      || pageSize !== 1 && (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0)
      || header[18] !== 1 || header[19] !== 1 || header[21] !== 64 || header[22] !== 32 || header[23] !== 32
      || header.readUInt32BE(44) !== 4 || header.readUInt32BE(56) !== 1) throw unsupportedFormat();
  if (!supportedVersion(header.readUInt32BE(60), allowUpgrade)) throw new Error('Unsupported database version; no data was reset.');
  // SQLite can follow paths in super-journal pointers. Daymark only uses single-database transactions.
  if (journal?.size >= 16 && readBytes(path + '-journal', 8, journal.size - 8).equals(rollbackMagic)) throw unsupportedFormat();
  return { journal: !!journal };
}

const schemaIdentity = db => JSON.stringify(db.prepare('SELECT type, name, tbl_name, CAST(sql AS BLOB) AS sql FROM main.sqlite_schema ORDER BY type,name').all());
const schemaIdentities = new Map();
function assertDatabase(db, allowUpgrade = false) {
  const version = db.prepare('PRAGMA main.user_version').get().user_version;
  if (!supportedVersion(version, allowUpgrade))
    throw new Error('Unsupported database version; no data was reset.');
  if (!schemaIdentities.has(version)) {
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(schema);
      if (version >= 11) expected.exec(addTaskFields);
      if (version >= 12) expected.exec(rebuildTaskWorkflow);
      if (version >= 13) expected.exec(cutoverTaskWorkflow);
      if (version >= 14) expected.exec(addTaskCreateGuard);
      schemaIdentities.set(version, schemaIdentity(expected));
    }
    finally { expected.close(); }
  }
  if (schemaIdentity(db) !== schemaIdentities.get(version)) throw new Error('Unsupported database schema; no data was reset.');
  if (db.prepare('PRAGMA main.integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA main.foreign_key_check').all().length)
    throw new Error('Database integrity check failed; no data was reset.');
  return version;
}

function preflightData(path, allowUpgrade) {
  const file = inspectDataFile(path, allowUpgrade);
  if (!file) return false;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try { assertDatabase(db, allowUpgrade); } finally { db.close(); }
  } catch (error) {
    // SQLITE_READONLY_ROLLBACK means SQLite could not read the file without recovering its journal.
    if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 776 || !file.journal) throw error;
    const journalPath = path + '-journal';
    if (!readBytes(journalPath, 8).equals(rollbackMagic)) throw unsupportedFormat();
    const disposable = mkdtempSync(join(dirname(path), '.daymark-recovery-'));
    try {
      const copy = join(disposable, 'app.sqlite');
      copyFileSync(path, copy);
      copyFileSync(journalPath, copy + '-journal');
      const db = new DatabaseSync(copy);
      try { assertDatabase(db, allowUpgrade); } finally { db.close(); }
      const recovered = inspectDataFile(copy, allowUpgrade);
      if (!recovered || recovered.journal) throw unsupportedFormat();
    } finally { rmSync(disposable, { recursive: true, force: true }); }
  }
  return true;
}

export function openData(path, { allowUpgrade = true } = {}) {
  const existing = path !== ':memory:' && preflightData(path, allowUpgrade);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Foreign keys are required.');
    if (existing) {
      if (assertDatabase(db, allowUpgrade) !== schemaVersion) transaction(db, () => {
        const version = assertDatabase(db, allowUpgrade);
        if (version === schemaVersion) return;
        if (version === 10) db.exec(addTaskFields);
        if (version < 12) db.exec(rebuildTaskWorkflow);
        if (version < 13) {
          const pending = db.prepare("SELECT count(*) AS total,count(revoked_at) AS revoked FROM task_events WHERE state='PENDING'").get();
          if (pending.total > pending.revoked) throw new Error(`Keir 2 cutover blocked by unresolved pending task events (${pending.total} total, ${pending.revoked} revoked). Keep the previous app until any event that cannot settle has an explicit disposition.`);
          if (db.prepare('SELECT 1 FROM extension_selections WHERE generation=9007199254740991 LIMIT 1').get())
            throw new Error('Keir 2 cutover blocked by a selection generation at its limit.');
          loadHost();
          db.exec(cutoverTaskWorkflow);
        }
        db.exec(addTaskCreateGuard);
        db.exec('PRAGMA user_version=' + schemaVersion);
        assertDatabase(db);
      });
    }
    else transaction(db, () => {
      db.exec(schema);
      db.exec(addTaskFields);
      db.exec(rebuildTaskWorkflow);
      db.exec(cutoverTaskWorkflow);
      db.exec(addTaskCreateGuard);
      db.exec('INSERT INTO authoring_budget VALUES (1, 0)');
      seedRows(db);
      db.exec('PRAGMA user_version=' + schemaVersion);
    });
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function resetData(directory, confirmed, backupDatabase = backup) {
  if (!confirmed) throw new Error('Reset requires --confirm and a stopped app.');
  const release = acquireDataLock(directory);
  let db;
  try {
    db = openData(join(resolve(directory), 'app.sqlite'), { allowUpgrade: false });
    const backupDir = join(resolve(directory), 'backups');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `${Date.now()}-${randomUUID()}.sqlite`);
    await backupDatabase(db, backupPath);
    let copy;
    try {
      const file = inspectDataFile(backupPath);
      if (!file || file.journal) throw unsupportedFormat();
      copy = new DatabaseSync(backupPath, { readOnly: true });
      assertDatabase(copy);
    } catch (error) {
      copy?.close();
      throw new Error('Backup verification failed; original data retained.', { cause: error });
    }
    try {
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
const taskColumns = 'id, project_id AS projectId, title, notes, status, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt, tags, priority, due_at AS dueAt';
const taskDto = row => ({ ...row, tags: JSON.parse(row.tags) });

function tag(value) {
  try { return normalizeTaskTag(value); }
  catch (error) { throw new AppError(400, error.message); }
}

function tags(value) {
  try { return JSON.stringify(normalizeTaskTags(value)); }
  catch (error) { throw new AppError(400, error.message); }
}

function taskPriority(value) {
  if (!['low', 'normal', 'high'].includes(value)) throw new AppError(400, 'Choose low, normal or high priority.');
  return value;
}

function taskDueAt(value) {
  if (value === null) return null;
  if (typeof value === 'string' && value.length === 24 && value >= '0001-01-01T00:00:00.000Z') {
    const instant = new Date(value);
    if (Number.isFinite(instant.getTime()) && instant.toISOString() === value) return value;
  }
  throw new AppError(400, 'Use a valid UTC due time in YYYY-MM-DDTHH:mm:ss.sssZ format.');
}

function insertTask(db, owner, projectId, title, notes, savedTags = '[]', priority = 'normal', dueAt = null, now = new Date().toISOString()) {
  const id = randomUUID();
  db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at,tags,priority,due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner, projectId, title, notes, 'open', now, now, null, savedTags, priority, dueAt);
  return id;
}

function captureTaskEvent(db, owner, hookId, taskId, occurredAt) {
  const selected = db.prepare(`SELECT s.*,l.extension_id FROM extension_selections s LEFT JOIN extension_revision_links l
    ON l.revision_id=s.revision_id AND l.owner_id=s.owner_id WHERE s.owner_id=? AND s.hook_id=?`).get(owner, hookId);
  const bound = selected?.revision_id;
  db.prepare(`INSERT INTO task_events(event_id,owner_id,source_task_id,hook_id,original_key,item_id,revision_id,selection_generation,input,pins,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), owner, taskId, hookId, randomUUID(), bound ? selected.extension_id : null,
    bound || null, selected?.generation ?? 0, JSON.stringify({ taskId, occurredAt }), bound ? selected.binding_pins : null,
    bound ? 'PENDING' : 'NO_BINDING', occurredAt);
}

function normalizeCreate(input, automation = false) {
  fields(input, automation ? ['projectId', 'title', 'notes', 'tagsText', 'priority', 'dueAt'] : ['projectId', 'title', 'notes', 'tags', 'priority', 'dueAt']);
  if (typeof input.projectId !== 'string') throw new AppError(400, 'Choose a project.');
  if (automation && input.dueAt === null) throw new AppError(400, 'Choose a valid due time.');
  let title, savedTags;
  try {
    title = automation ? normalizeWorkflowTitle(input.title) : text(input.title, 'Task title', 120);
    savedTags = automation ? parseWorkflowTagsText(input.tagsText) : JSON.parse(tags(Object.hasOwn(input, 'tags') ? input.tags : []));
  } catch (error) { throw new AppError(400, error.message); }
  return freezeContext({
    projectId: input.projectId,
    title,
    notes: text(automation && Object.hasOwn(input, 'notes') ? input.notes : input.notes ?? '', 'Notes', 4000, false),
    tags: savedTags,
    priority: Object.hasOwn(input, 'priority') ? taskPriority(input.priority) : 'normal',
    dueAt: Object.hasOwn(input, 'dueAt') ? taskDueAt(input.dueAt) : null,
  });
}

const createGuardError = (message, denied = false, stale = false) => Object.assign(new AppError(denied ? 422 : stale ? 409 : 503, message), {
  code: denied ? 'TASK_CREATE_DENIED' : stale ? 'TASK_CREATE_STALE' : 'TASK_CREATE_UNAVAILABLE',
});
const guardSelection = (db, owner) => db.prepare("SELECT * FROM extension_selections WHERE owner_id=? AND hook_id='TaskBeforeCreate'").get(owner);

async function prepareTaskCreate(db, owner, proposal, guard, context = {}) {
  const clock = context.deadline?.clock ?? { nowMs: () => Math.floor(performance.now()) };
  const deadline = context.deadline ?? { clock, expiresAtMs: clock.nowMs() + 1000 };
  const started = clock.nowMs();
  function authority() {
    const now = clock.nowMs();
    if (typeof owner !== 'string' || !owner || !db.prepare('SELECT 1 FROM users WHERE id=?').get(owner)
      || context.authorize && context.authorize() !== owner) throw new AppError(401, 'Your demo session changed. Sign in again.');
    if (context.signal?.aborted || !Number.isSafeInteger(now) || now < started || !Number.isSafeInteger(deadline.expiresAtMs)
      || now >= deadline.expiresAtMs) throw createGuardError('The task check expired. Your entries are kept.', false, true);
    if (!db.prepare('SELECT 1 FROM projects WHERE owner_id=? AND id=?').get(owner, proposal.projectId)) throw notFound();
  }
  authority();
  const selection = guardSelection(db, owner);
  if (!selection) throw createGuardError('The task check is not configured. Your entries are kept.');
  const identity = json(selection);
  const input = freezeContext({ projectId: proposal.projectId, priority: proposal.priority, tags: [...proposal.tags],
    hasNotes: proposal.notes.trim().length > 0, hasDueDate: proposal.dueAt !== null });
  let decision = null;
  if (selection.revision_id) {
    if (!guard || typeof guard.check !== 'function' || typeof guard.current !== 'function'
      || !Number.isSafeInteger(guard.commitReserveMs) || guard.commitReserveMs <= 0) {
      decision = { status: 'BLOCKED' };
    } else {
      let timer, abort;
      try {
        const expiresAtMs = deadline.expiresAtMs - guard.commitReserveMs;
        const remaining = expiresAtMs - clock.nowMs();
        if (remaining <= 0) throw new Error('No guard budget remains');
        const stopped = new Promise(resolve => {
          timer = setTimeout(() => resolve({ status: 'BLOCKED' }), remaining);
          abort = () => resolve({ status: 'BLOCKED' });
          context.signal?.addEventListener('abort', abort, { once: true });
        });
        decision = await Promise.race([guard.check({ owner, input, selection: freezeContext({ ...selection }),
          deadline: { clock, expiresAtMs }, operationDeadline: deadline, signal: context.signal,
          requestKey: context.requestKey ?? Object.freeze({ type: 'demo.TaskCreateKey/1', value: randomUUID() }) }), stopped]);
        const completedAt = clock.nowMs();
        if (!Number.isSafeInteger(completedAt) || completedAt < started || completedAt >= expiresAtMs) decision = { status: 'BLOCKED' };
      } catch { decision = { status: 'BLOCKED' }; }
      finally { clearTimeout(timer); if (abort) context.signal?.removeEventListener('abort', abort); }
    }
  }
  function validate(phase) {
    authority();
    if (json(guardSelection(db, owner)) !== identity) throw createGuardError('The task rule changed. Check it again before adding this task.', false, true);
    if (!selection.revision_id) return null;
    let current = false;
    try { current = guard?.current(decision, phase) === true; } catch { /* Unavailable authority blocks creation. */ }
    if (!current) throw createGuardError('The task rule could not be checked. Your entries are kept.');
    if (decision?.status === 'DENIED') {
      const message = typeof decision.message === 'string' && decision.message.isWellFormed() && Buffer.byteLength(decision.message) <= 256
        ? decision.message.trim() : '';
      throw createGuardError(message || 'This task does not meet the rule. Your entries are kept.', true);
    }
    if (decision?.status !== 'ALLOWED')
      throw createGuardError('The task rule could not be checked. Your entries are kept.');
    return decision;
  }
  return {
    validate: () => validate('BEFORE_WRITE'),
    validateAfterWrite: () => validate('AFTER_WRITE'),
  };
}

export function taskService(db, { guard } = {}) {
  function operationId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
      throw new AppError(400, 'Use a valid task creation ID.');
    return value;
  }
  function authorizeCreate(owner, context) {
    if (typeof owner !== 'string' || !db.prepare('SELECT 1 FROM users WHERE id=?').get(owner)
        || context.authorize && context.authorize() !== owner) throw new AppError(401, 'Your demo session changed. Sign in again.');
  }
  function savedOperation(owner, id, context, candidate) {
    authorizeCreate(owner, context);
    const row = db.prepare('SELECT candidate,result FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, id);
    if (!row) return null;
    project(owner, JSON.parse(Buffer.from(row.candidate).toString('utf8')).projectId);
    if (candidate && !Buffer.from(row.candidate).equals(candidate))
      throw Object.assign(new AppError(409, 'This task creation ID belongs to a different attempt.'), { code: 'CREATE_PAYLOAD_MISMATCH' });
    authorizeCreate(owner, context);
    return JSON.parse(Buffer.from(row.result).toString('utf8'));
  }
  function notCreated(error) {
    const code = { TASK_CREATE_DENIED: 'RULE_DENIED', TASK_CREATE_UNAVAILABLE: 'CHECK_UNAVAILABLE', TASK_CREATE_STALE: 'STALE_ATTEMPT' }[error.code];
    if (code || error instanceof AppError && error.status === 400)
      return { state: 'NOT_CREATED', code: code ?? 'NATIVE_REJECTED', message: error.message };
    throw error;
  }
  function returnOperation(id, result) {
    if (result.state === 'CREATED') return result.task;
    throw Object.assign(new AppError(result.code === 'CHECK_UNAVAILABLE' ? 503 : result.code === 'STALE_ATTEMPT' ? 409 : 422, result.message),
      { operationId: id, ...result });
  }
  function project(owner, id) {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE owner_id = ? AND id = ?`).get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  function task(owner, id) {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE owner_id = ? AND id = ?`).get(owner, id);
    if (!row) throw notFound();
    return taskDto(row);
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
    listTasks(owner, id) { project(owner, id); return db.prepare(`SELECT ${taskColumns} FROM tasks WHERE owner_id = ? AND project_id = ? ORDER BY created_at, id`).all(owner, id).map(taskDto); },
    searchTasks(owner, id, input) {
      project(owner, id);
      fields(input, ['q', 'tag', 'after']);
      const conditions = ['owner_id = ?', 'project_id = ?'];
      const args = [owner, id];
      if (Object.hasOwn(input, 'q')) {
        if (typeof input.q !== 'string' || !input.q.isWellFormed() || /\p{Cc}/u.test(input.q)) throw new AppError(400, 'Use search text without control characters.');
        const query = text(input.q, 'Search text', 120);
        conditions.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(notes), lower(?)) > 0)');
        args.push(query, query);
      }
      if (Object.hasOwn(input, 'tag')) {
        conditions.push('EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value = ?)');
        args.push(tag(input.tag));
      }
      if (conditions.length === 2) throw new AppError(400, 'Enter search text or a tag.');
      if (Object.hasOwn(input, 'after')) {
        const after = input.after;
        if (typeof after !== 'string' || !after.isWellFormed() || !after || after.length > 128 || /[\p{Cc}\s]/u.test(after)) throw new AppError(400, 'Use a valid task search cursor.');
        const anchor = db.prepare('SELECT created_at FROM tasks WHERE owner_id = ? AND project_id = ? AND id = ?').get(owner, id, after);
        if (!anchor) throw notFound();
        conditions.push('(created_at, id) > (?, ?)');
        args.push(anchor.created_at, after);
      }
      const rows = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at, id LIMIT 26`).all(...args);
      const items = rows.slice(0, 25).map(taskDto);
      return { items, nextAfter: rows.length > items.length ? items.at(-1).id : null };
    },
    getTask: task,
    getTaskForCustomization(owner, id) {
      // SQLite TEXT reads stop at embedded NUL; the model must see the saved title without truncation.
      const row = db.prepare('SELECT id, project_id AS projectId, status, CAST(title AS BLOB) AS title, tags, priority, due_at AS dueAt FROM tasks WHERE owner_id=? AND id=?').get(owner, id);
      if (!row) throw notFound();
      return { ...row, title: Buffer.from(row.title).toString('utf8'), tags: JSON.parse(row.tags) };
    },
    hasOpenTask(owner, projectId, exactTitle, deadline) {
      if (!validOpenMatchInput(projectId, exactTitle)) throw new AppError(400, 'Choose a project and exact task title.');
      const checkDeadline = () => {
        const now = deadline?.clock?.nowMs?.();
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline.expiresAtMs) || now >= deadline.expiresAtMs)
          throw new AppError(503, 'The open-task check expired.');
      };
      checkDeadline();
      const result = db.prepare(`SELECT EXISTS(SELECT 1 FROM tasks WHERE owner_id=projects.owner_id AND project_id=projects.id
        AND status='open' AND title COLLATE BINARY=?) AS matches FROM projects WHERE owner_id=? AND id=?`).get(exactTitle, owner, projectId);
      checkDeadline();
      if (!result) throw notFound();
      return { matches: Boolean(result.matches) };
    },
    getCreateOperation(owner, id, context = {}) {
      operationId(id);
      const result = savedOperation(owner, id, context);
      return { operationId: id, ...(result ?? { state: 'UNRESOLVED' }) };
    },
    async createTask(owner, input, context = {}) {
      const id = operationId(context.operationId);
      if (Object.hasOwn(context, 'requestKey')) throw new AppError(400, 'Use native task creation metadata.');
      const proposal = normalizeCreate(input);
      const candidate = Buffer.from(json(proposal));
      authorizeCreate(owner, context);
      project(owner, proposal.projectId);
      const prior = savedOperation(owner, id, context, candidate);
      if (prior) return returnOperation(id, prior);
      let gate, failure;
      try { gate = await prepareTaskCreate(db, owner, proposal, guard, { ...context,
        requestKey: Object.freeze({ type: 'demo.TaskWorkflowKey/1', value: id }) }); }
      catch (error) { failure = error; }
      const result = transaction(db, () => {
        authorizeCreate(owner, context);
        const winner = savedOperation(owner, id, context, candidate);
        if (winner) return winner;
        project(owner, proposal.projectId);
        const record = result => db.prepare('INSERT INTO task_create_operations(owner_id,operation_id,candidate,result) VALUES (?,?,?,?)')
          .run(owner, id, candidate, Buffer.from(JSON.stringify(result)));
        let terminal;
        if (failure) { terminal = notCreated(failure); record(terminal); }
        else {
          db.exec('SAVEPOINT interactive_task_create');
          try {
            gate.validate();
            const now = new Date().toISOString();
            const taskId = insertTask(db, owner, proposal.projectId, proposal.title, proposal.notes, JSON.stringify(proposal.tags), proposal.priority, proposal.dueAt, now);
            captureTaskEvent(db, owner, createdHook, taskId, now);
            gate.validateAfterWrite();
            terminal = { state: 'CREATED', task: task(owner, taskId) };
            record(terminal);
            gate.validateAfterWrite();
          } catch (error) {
            terminal = notCreated(error);
            db.exec('ROLLBACK TO interactive_task_create');
            record(terminal);
          }
          db.exec('RELEASE interactive_task_create');
        }
        authorizeCreate(owner, context);
        project(owner, proposal.projectId);
        return terminal;
      });
      return returnOperation(id, result);
    },
    editTask(owner, id, input) {
      fields(input, ['title', 'notes', 'tags', 'priority', 'dueAt']);
      task(owner, id);
      const savedTags = Object.hasOwn(input, 'tags') ? tags(input.tags) : null;
      const priority = Object.hasOwn(input, 'priority') ? taskPriority(input.priority) : null;
      const hasDueAt = Object.hasOwn(input, 'dueAt');
      const dueAt = hasDueAt ? taskDueAt(input.dueAt) : null;
      const editText = Object.hasOwn(input, 'title') || Object.hasOwn(input, 'notes') || savedTags === null && priority === null && !hasDueAt;
      const title = editText ? text(input.title, 'Task title', 120) : null;
      const notes = editText ? text(input.notes, 'Notes', 4000, false) : null;
      db.prepare(`UPDATE tasks SET title=coalesce(?,title), notes=coalesce(?,notes), tags=coalesce(?,tags),
        priority=coalesce(?,priority), due_at=CASE WHEN ? THEN ? ELSE due_at END, updated_at=?
        WHERE owner_id=? AND id=?`).run(title, notes, savedTags, priority, Number(hasDueAt), dueAt, new Date().toISOString(), owner, id);
      return task(owner, id);
    },
    completeTask(owner, id) {
      return transaction(db, () => {
        task(owner, id);
        const now = new Date().toISOString();
        const changed = db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'open'").run(now, now, owner, id).changes;
        if (changed) captureTaskEvent(db, owner, TASK_HOOK, id, now);
        return task(owner, id);
      });
    },
  };
}

// Called inside the lifecycle transaction; revocation never erases settled native evidence.
export function revokeTaskAdmissions(db, owner, itemId) {
  db.prepare("UPDATE task_events SET revoked_at=? WHERE owner_id=? AND item_id=? AND state IN ('PENDING','STARTED') AND revoked_at IS NULL")
    .run(Date.now(), owner, itemId);
  db.prepare(`UPDATE extension_selections SET revision_id=NULL,binding_pins=NULL,generation=generation+1
    WHERE owner_id=? AND revision_id IN
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
  return freezeContext({ eventId: row.event_id, owner: row.owner_id, sourceTaskId: row.source_task_id, originalKey: row.original_key, hookId: row.hook_id,
    itemId: row.item_id, revisionId: row.revision_id, selectionGeneration: row.selection_generation,
    input: parse(row.input), pins: parse(row.pins), state: row.state, revokedAt: row.revoked_at,
    outcome: parse(row.outcome), reconciliation: parse(row.reconciliation) });
}

// Native storage owns key authenticity, current resource access and atomic task/receipt writes.
export function taskEffectService(db, options = {}) {
  if (arguments.length > 2 || typeof db?.prepare !== 'function' || !options || typeof options !== 'object'
      || Object.keys(options).some(name => name !== 'guard')) throw new TypeError('Task effects require one native database and its guard.');
  const { guard } = options;
  const tasks = taskService(db);
  const hosts = new Map();
  const event = (owner, id) => {
    const row = db.prepare('SELECT * FROM task_events WHERE owner_id=? AND event_id=?').get(owner, id);
    if (!row) throw notFound();
    return row;
  };
  const receipt = row => db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(row.owner_id, row.original_key);
  const canRead = context => tasks.getTask(context.owner, context.sourceTaskId);
  function current(row, invocation) {
    try {
      const context = contextFor(row.owner_id, invocation), pins = context.pins;
      const hostKey = json({ model: pins?.modelDigest, hook: row.hook_id });
      let host = hosts.get(hostKey);
      if (!host) { host = definitionForPins(pins); hosts.set(hostKey, host); }
      const now = invocation.deadline.clock.nowMs();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(invocation.deadline.expiresAtMs)
          || now >= invocation.deadline.expiresAtMs || context.eventId !== row.event_id || row.revoked_at !== null
          || !pins || Object.hasOwn(pins, 'profile') || Object.hasOwn(pins, 'qualification')
          || context.input?.taskId !== row.source_task_id || context.input?.occurredAt !== row.created_at) return false;
      if (!host || host.pins.hook !== row.hook_id || Object.entries(host.pins).some(([name, value]) => json(pins[name]) !== json(value))) return false;
      // Re-read persisted authority; a mutable current selection cannot replace the captured admission.
      const saved = db.prepare(`SELECT r.*,a.source,a.artifact,a.suite FROM task_events v JOIN tasks t ON t.id=v.source_task_id AND t.owner_id=v.owner_id
      JOIN extension_revision_links l ON l.revision_id=v.revision_id AND l.owner_id=v.owner_id AND l.extension_id=v.item_id
      JOIN extensions e ON e.id=l.extension_id AND e.owner_id=l.owner_id
      JOIN extension_revisions r ON r.id=l.revision_id AND r.owner_id=l.owner_id
      JOIN extension_authored a ON a.revision_id=r.id AND a.owner_id=r.owner_id
      WHERE v.event_id=? AND v.owner_id=? AND v.revoked_at IS NULL AND e.deleted_at IS NULL
        AND (v.hook_id='TaskCreated' OR t.status='completed') AND e.hook_id=v.hook_id AND r.provenance='customer'`).get(row.event_id, row.owner_id);
      if (!saved) return false;
      const identity = JSON.parse(saved.identity), artifact = JSON.parse(Buffer.from(saved.artifact).toString('utf8'));
      if (json(pins) !== json({ ...identity, approvedEvidenceId: pins.approvedEvidenceId })
          || identity.artifactDigest !== digest(saved.artifact) || identity.rawSourceDigest !== digest(saved.source)
          || artifact.format !== (pins.modelRef.format === 'keir-dcm/3' ? 'keir-artifact/3' : 'keir-artifact/2') || artifact.entrypoint !== row.hook_id
          || identity.compiledSourceDigest !== artifact.sourceDigest || identity.suiteDigest !== digest(saved.suite)) return false;
      const validProof = id => {
        const proof = db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND revision_id=? AND id=?').get(row.owner_id, saved.id, id);
        return taskEffectProofMatches(saved, saved, proof, host);
      };
      const approval = db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(row.owner_id, saved.id);
      if (!approval || !validProof(approval.evidence_id) || typeof pins.approvedEvidenceId !== 'string' || !validProof(pins.approvedEvidenceId)) return false;
      const checkedAt = invocation.deadline.clock.nowMs();
      return Number.isSafeInteger(checkedAt) && checkedAt >= 0 && checkedAt < invocation.deadline.expiresAtMs;
    } catch { return false; }
  }
  function deny(row) {
    db.prepare('UPDATE task_events SET revoked_at=? WHERE event_id=? AND owner_id=? AND revoked_at IS NULL')
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
  const rejection = code => ({ kind: 'BUSINESS_REJECTION', code, effect: 'NONE' });
  const success = id => ({ kind: 'SUCCESS', value: { id }, effect: 'CONFIRMED' });

  function applyWorkflowWrite(owner, row, capability, input, proposal) {
    try {
      if (capability === 'tasks.create') {
        const project = db.prepare('SELECT 1 FROM projects WHERE owner_id=? AND id=?').get(owner, input.projectId);
        if (!project) return { response: rejection('PROJECT_NOT_FOUND') };
        const { title, notes, tags: savedTags, priority, dueAt } = proposal;
        // The native insert is shared with human creation. Only the human path captures TaskCreated.
        const id = insertTask(db, owner, input.projectId, title, notes, JSON.stringify(savedTags), priority, dueAt);
        return { response: success(id), observation: { created: { id, projectId: input.projectId, title, notes, tags: savedTags, priority, dueAt } } };
      }
      const id = row.source_task_id, task = tasks.getTask(owner, id);
      const before = { tags: task.tags, priority: task.priority, dueAt: task.dueAt };
      if (!Object.keys(input).length || input.dueAt === null) return { response: rejection('TASK_INVALID') };
      const after = {
        tags: Object.hasOwn(input, 'addTag') ? JSON.parse(tags([...task.tags, input.addTag])) : task.tags,
        priority: Object.hasOwn(input, 'priority') ? taskPriority(input.priority) : task.priority,
        dueAt: Object.hasOwn(input, 'dueAt') ? taskDueAt(input.dueAt) : task.dueAt,
      };
      if (json(before) !== json(after)) db.prepare('UPDATE tasks SET tags=?,priority=?,due_at=?,updated_at=? WHERE owner_id=? AND id=?')
        .run(JSON.stringify(after.tags), after.priority, after.dueAt, new Date().toISOString(), owner, id);
      return { response: success(id), observation: { updated: { id, before, after } } };
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return { response: rejection('TASK_NOT_FOUND') };
      if (error instanceof AppError && error.status === 400) return { response: rejection('TASK_INVALID') };
      throw error;
    }
  }

  function inspectWrite(owner, key, input, invocation, capability, version) {
    const row = fromKey(owner, key);
    if (invocation?.requestKey !== key) throw effectError('HOST_CONTEXT_INVALID', 400);
    contextFor(owner, invocation);
    const legacy = version === '1' && capability === 'tasks.create';
    if (capability === 'tasks.create') fields(input, legacy ? ['projectId', 'title'] : ['projectId', 'title', 'notes', 'tagsText', 'priority', 'dueAt']);
    else fields(input, ['addTag', 'priority', 'dueAt']);
    if (capability === 'tasks.create' && (typeof input.projectId !== 'string' || typeof input.title !== 'string'))
      throw effectError('INPUT_INVALID', 400);
    if (Object.values(input).some(value => value !== null && (typeof value !== 'string' || !value.isWellFormed()
        || !legacy && Buffer.byteLength(value) > 256))) throw effectError('INPUT_INVALID', 400);
    // Historical payload encoding is part of its saved identity. Keir 2 compares authored bytes before native normalization.
    const payload = Buffer.from(legacy ? JSON.stringify({ projectId: input.projectId, title: text(input.title, 'Task title', 120) }) : json(input));
    const prior = receipt(row);
    if (prior) {
      if (prior.capability_id !== capability || prior.capability_version !== version || !Buffer.from(prior.payload).equals(payload))
        return { settled: true, response: rejection('KEY_PAYLOAD_MISMATCH') };
      if (prior.affected_task_id) tasks.getTask(owner, prior.affected_task_id);
      return { settled: true, response: resultOf(prior) };
    }
    return { row, payload, legacy };
  }

  function createFailure(error) {
    if (error instanceof AppError && error.status === 404) return { response: rejection('PROJECT_NOT_FOUND') };
    if (error instanceof AppError && error.status === 400) return { response: rejection('TASK_INVALID') };
    if (['TASK_CREATE_DENIED', 'TASK_CREATE_UNAVAILABLE', 'TASK_CREATE_STALE'].includes(error.code)) return {
      response: error.code === 'TASK_CREATE_DENIED' ? rejection('TASK_INVALID') : { kind: 'TRANSIENT_FAILURE', effect: 'NONE' },
      guardDetails: JSON.stringify({ code: error.code, message: error.message }),
    };
    throw error;
  }

  function writeOnce(owner, key, input, invocation, capability, version, creation) {
    const result = transaction(db, () => {
      const checked = inspectWrite(owner, key, input, invocation, capability, version);
      if (checked.settled) return checked.response;
      const { row, payload, legacy } = checked;
      if (row.state !== 'STARTED') throw effectError('EVENT_NOT_STARTED', 409);
      if (legacy || !current(row, invocation)) return deny(row);

      db.exec('SAVEPOINT task_workflow_effect');
      let applied;
      try {
        if (creation?.failure) applied = createFailure(creation.failure);
        else {
          creation?.gate.validate();
          applied = applyWorkflowWrite(owner, row, capability, input, creation?.proposal);
          creation?.gate.validateAfterWrite();
        }
      } catch (error) {
        if (!creation) throw error;
        if (!current(event(owner, row.event_id), invocation)) {
          db.exec('ROLLBACK TO task_workflow_effect; RELEASE task_workflow_effect');
          return deny(row);
        }
        applied = createFailure(error);
        db.exec('ROLLBACK TO task_workflow_effect');
      }
      const record = () => {
        const { response, observation, guardDetails } = applied;
        db.prepare(`INSERT INTO task_effect_receipts(owner_id,capability_id,original_key,capability_version,payload,result,effect,affected_task_id,observation,guard_details)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(owner, capability, row.original_key, version, payload, JSON.stringify(response), response.effect,
          response.value?.id ?? null, observation ? JSON.stringify(observation) : null, guardDetails ?? null);
      };
      record();
      if (creation?.gate && applied.response.kind === 'SUCCESS') {
        try { creation.gate.validateAfterWrite(); }
        catch (error) {
          if (!current(event(owner, row.event_id), invocation)) {
            db.exec('ROLLBACK TO task_workflow_effect; RELEASE task_workflow_effect');
            return deny(row);
          }
          applied = createFailure(error);
          db.exec('ROLLBACK TO task_workflow_effect');
          record();
        }
      }
      const after = event(owner, row.event_id);
      if (after.state !== 'STARTED' || !current(after, invocation)) {
        db.exec('ROLLBACK TO task_workflow_effect; RELEASE task_workflow_effect');
        return deny(row);
      }
      db.exec('RELEASE task_workflow_effect');
      return applied.response;
    });
    if (result instanceof Error) throw result;
    return result;
  }

  function observed(row) {
    const stored = receipt(row);
    return { receipt: resultOf(stored),
      ...(stored?.observation ? { observation: JSON.parse(stored.observation), capability: stored.capability_id } : {}) };
  }
  return {
    keyFor(owner, eventId) {
      const row = event(owner, eventId); canRead(taskEvent(row));
      const type = Object.hasOwn(JSON.parse(row.input), 'occurredAt') ? 'demo.TaskWorkflowKey/1' : 'demo.TaskCompletionKey/1';
      const key = Object.freeze({ type, value: row.original_key });
      nativeKeys.set(key, { db, owner, eventId, originalKey: row.original_key });
      return key;
    },
    contextFor,
    claim(owner, eventId, invocation) {
      const result = transaction(db, () => {
        const row = event(owner, eventId);
        if (row.state !== 'PENDING') return null;
        if (!current(row, invocation)) return deny(row);
        db.prepare("UPDATE task_events SET state='STARTED' WHERE owner_id=? AND event_id=? AND state='PENDING'").run(owner, eventId);
        const claimed = event(owner, eventId);
        if (claimed.state !== 'STARTED' || !current(claimed, invocation)) return deny(row);
        return taskEvent(claimed);
      });
      if (result instanceof Error) throw result;
      return result;
    },
    async createTaskOnce(owner, key, input, invocation) {
      const version = key?.type === 'demo.TaskCompletionKey/1' ? '1' : '2';
      const checked = inspectWrite(owner, key, input, invocation, 'tasks.create', version);
      if (checked.settled) return checked.response;
      if (checked.row.state !== 'STARTED') throw effectError('EVENT_NOT_STARTED', 409);
      if (checked.legacy || !current(checked.row, invocation))
        return writeOnce(owner, key, input, invocation, 'tasks.create', version);
      input = Object.freeze({ ...input });
      let creation;
      try {
        const proposal = normalizeCreate(input, true);
        const gate = await prepareTaskCreate(db, owner, proposal, guard, { ...invocation,
          authorize: () => current(event(owner, checked.row.event_id), invocation) ? owner : null });
        creation = { proposal, gate };
      } catch (failure) { creation = { failure }; }
      return writeOnce(owner, key, input, invocation, 'tasks.create', version, creation);
    },
    updateTaskOnce(owner, key, input, invocation) {
      return writeOnce(owner, key, input, invocation, 'tasks.update', '1');
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
        db.prepare("UPDATE task_events SET state='FINISHED',outcome=? WHERE owner_id=? AND event_id=?").run(encoded, owner, eventId);
        return true;
      });
    },
    status(owner, eventId) {
      const row = event(owner, eventId); canRead(taskEvent(row));
      return { ...taskEvent(row), ...observed(row) };
    },
    reconcile(owner, eventId) {
      return transaction(db, () => {
        const row = event(owner, eventId); canRead(taskEvent(row));
        const observation = { observedAt: new Date().toISOString(), ...observed(row) };
        db.prepare('UPDATE task_events SET reconciliation=? WHERE owner_id=? AND event_id=?').run(JSON.stringify(observation), owner, eventId);
        return observation;
      });
    },
  };
}
