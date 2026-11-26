import { ownedProjectDefinitionId, SHARED_CREATED_UPDATE, TASK_CREATED } from './extension-catalog.mjs';

// Arm the new Personal definition at native admission without changing the v24 triggers or backfilling events.
export function armOwnedCreatedUpdate(db, eventId, taskId, definitionId) {
  if (!['2', '3', '5'].some(version => definitionId === ownedProjectDefinitionId(TASK_CREATED, version))) return;
  if (!db.isTransaction) throw new Error('Task update protection requires native admission.');
  db.prepare('INSERT INTO shared_created_updates(event_id,source_id) VALUES (?,?)').run(eventId, taskId);
}

export const sharedBundleTables = ['shared_personal_created_receipts', 'shared_personal_hook_payloads'];
export const sharedPersonalAdmissionTable = 'shared_personal_completion_pins';
export const sharedCompletionTables = ['shared_created_updates', sharedPersonalAdmissionTable, ...sharedBundleTables, 'shared_priority_fences', 'shared_completion_events', 'shared_completion_roots'];

export const addSharedCreatedUpdates = `
  CREATE TABLE shared_created_updates(
    event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)),
    receipt TEXT CHECK(receipt IS NULL OR (valid=0 AND json_valid(receipt) AND length(CAST(receipt AS BLOB))<=16384))) STRICT;
  CREATE TRIGGER shared_created_update_personal AFTER INSERT ON task_events
    WHEN NEW.hook_id='TaskCreated' AND NEW.state='PENDING'
      AND json_extract(NEW.pins,'$.definitionId')='${SHARED_CREATED_UPDATE}'
    BEGIN INSERT INTO shared_created_updates(event_id,source_id) VALUES (NEW.event_id,NEW.source_task_id); END;
  CREATE TRIGGER shared_created_update_team AFTER INSERT ON team_admissions
    WHEN NEW.state='PENDING' AND json_extract(NEW.manifest,'$.hooks.TaskCreated.definitionId')='${SHARED_CREATED_UPDATE}'
    BEGIN INSERT INTO shared_created_updates(event_id,source_id) VALUES (NEW.event_id,NEW.source_task_id); END;
  CREATE TRIGGER shared_created_update_edit AFTER UPDATE ON tasks
    BEGIN UPDATE shared_created_updates SET valid=0 WHERE source_id=OLD.id AND valid=1; END;
  CREATE TRIGGER shared_created_update_immutable BEFORE UPDATE ON shared_created_updates
    WHEN NEW.event_id IS NOT OLD.event_id OR NEW.source_id IS NOT OLD.source_id OR NEW.valid>OLD.valid OR OLD.receipt IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Shared created update is immutable'); END;
`;

export const addSharedPersonalCompletionPins = `
  CREATE TABLE shared_personal_completion_pins(
    event_id TEXT PRIMARY KEY REFERENCES task_events(event_id),
    owner_id TEXT NOT NULL, item_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    selection_generation INTEGER NOT NULL CHECK(selection_generation>=0),
    pins TEXT NOT NULL CHECK(json_valid(pins) AND length(CAST(pins AS BLOB))<=16384),
    revoked_at INTEGER,
    FOREIGN KEY(item_id,owner_id) REFERENCES extensions(id,owner_id),
    FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
  CREATE INDEX shared_personal_completion_pin_item ON shared_personal_completion_pins(owner_id,item_id);
  CREATE TRIGGER shared_personal_completion_pin_immutable BEFORE UPDATE ON shared_personal_completion_pins
    WHEN NEW.event_id IS NOT OLD.event_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.item_id IS NOT OLD.item_id
      OR NEW.revision_id IS NOT OLD.revision_id OR NEW.selection_generation IS NOT OLD.selection_generation
      OR NEW.pins IS NOT OLD.pins OR OLD.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Shared Personal admission pin is immutable'); END;
`;

export const addSharedTaskBundles = `
  CREATE TABLE shared_personal_hook_payloads(
    owner_id TEXT NOT NULL, revision_id TEXT NOT NULL, hook_id TEXT NOT NULL CHECK(hook_id IN ('TaskBeforeCreate','TaskCreated')),
    source BLOB NOT NULL CHECK(length(source) BETWEEN 1 AND 65536),
    artifact BLOB NOT NULL CHECK(length(artifact) BETWEEN 1 AND 1048576),
    PRIMARY KEY(owner_id,revision_id,hook_id),
    FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
  CREATE TRIGGER shared_personal_hook_immutable BEFORE UPDATE ON shared_personal_hook_payloads
    BEGIN SELECT RAISE(ABORT,'Shared hook payload is immutable'); END;
  CREATE TABLE shared_personal_created_receipts(
    event_id TEXT PRIMARY KEY REFERENCES task_events(event_id), task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    receipt TEXT NOT NULL CHECK(json_valid(receipt) AND length(CAST(receipt AS BLOB))<=16384)) STRICT;
  CREATE TRIGGER shared_personal_created_receipt_immutable BEFORE UPDATE ON shared_personal_created_receipts
    BEGIN SELECT RAISE(ABORT,'Shared created receipt is immutable'); END;
`;

export const addSharedPriorityFence = `
  CREATE TABLE shared_priority_fences(
    source_id TEXT PRIMARY KEY REFERENCES shared_completion_events(source_id) ON DELETE CASCADE) STRICT;
  CREATE TRIGGER shared_priority_fence_edit AFTER UPDATE ON tasks
    BEGIN DELETE FROM shared_priority_fences WHERE source_id=OLD.id; END;
`;

export const addSharedCompletion = `
  CREATE TABLE shared_completion_roots(
    root_id TEXT PRIMARY KEY REFERENCES team_admissions(event_id),
    activation_id TEXT NOT NULL REFERENCES team_activations(id)) STRICT;
  CREATE TABLE shared_completion_events(
    id TEXT PRIMARY KEY, original_key TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), actor_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT NOT NULL REFERENCES projects(id), occurred_at TEXT NOT NULL,
    personal_event_id TEXT UNIQUE REFERENCES task_events(event_id),
    root_id TEXT UNIQUE REFERENCES shared_completion_roots(root_id),
    state TEXT NOT NULL CHECK(state IN ('PENDING','STARTED','FINISHED')),
    outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=131072)),
    receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(CAST(receipt AS BLOB))<=16384)),
    created_task_id TEXT UNIQUE REFERENCES tasks(id),
    CHECK((state='FINISHED')=(outcome IS NOT NULL)), CHECK(receipt IS NULL OR state!='PENDING'),
    CHECK(created_task_id IS NULL OR receipt IS NOT NULL),
    CHECK((personal_event_id IS NULL)!=(root_id IS NULL))) STRICT;
  CREATE TRIGGER shared_completion_root_immutable BEFORE UPDATE ON shared_completion_roots
    BEGIN SELECT RAISE(ABORT,'Shared completion root is immutable'); END;
  CREATE TRIGGER shared_completion_event_immutable BEFORE UPDATE ON shared_completion_events
    WHEN NEW.id IS NOT OLD.id OR NEW.original_key IS NOT OLD.original_key OR NEW.source_id IS NOT OLD.source_id
      OR NEW.actor_id IS NOT OLD.actor_id OR NEW.project_id IS NOT OLD.project_id OR NEW.occurred_at IS NOT OLD.occurred_at
      OR NEW.personal_event_id IS NOT OLD.personal_event_id OR NEW.root_id IS NOT OLD.root_id
      OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NOT OLD.receipt OR NEW.created_task_id IS NOT OLD.created_task_id))
      OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
      OR (NEW.state IS NOT OLD.state AND NOT
        ((OLD.state='PENDING' AND NEW.state='STARTED') OR (OLD.state='STARTED' AND NEW.state='FINISHED')))
    BEGIN SELECT RAISE(ABORT,'Shared completion attempt is immutable'); END;
`;
