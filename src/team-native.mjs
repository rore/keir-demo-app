import { randomUUID } from 'node:crypto';
import { AppError, notFound, transaction } from './data.mjs';

export const teamTables = ['team_controls', 'team_activations', 'team_approvals', 'team_evidence', 'team_drafts', 'team_admissions', 'team_selections', 'team_revisions', 'project_members'];
export const addTeamControls = `
  CREATE TABLE team_controls(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('deactivations','revocations')),
    project_id TEXT NOT NULL, revision_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB))<=2048),
    result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=8192),
    created_at TEXT NOT NULL, UNIQUE(project_id,actor_id,operation_id),
    FOREIGN KEY(project_id,revision_id) REFERENCES team_revisions(project_id,revision_id)) STRICT;
  CREATE TRIGGER team_control_immutable BEFORE UPDATE ON team_controls
    BEGIN SELECT RAISE(ABORT,'Team control is immutable'); END;
  CREATE TRIGGER team_control_operation BEFORE INSERT ON team_controls
    WHEN EXISTS(SELECT 1 FROM team_approvals WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
      OR EXISTS(SELECT 1 FROM team_activations WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'Team operation already exists'); END;
  CREATE TRIGGER team_approval_control_operation BEFORE INSERT ON team_approvals
    WHEN EXISTS(SELECT 1 FROM team_controls WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'Team operation already exists'); END;
  CREATE TRIGGER team_activation_control_operation BEFORE INSERT ON team_activations
    WHEN EXISTS(SELECT 1 FROM team_controls WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'Team operation already exists'); END;
`;
export const addTeamLifecycle = `
  ALTER TABLE team_selections ADD COLUMN generation INTEGER NOT NULL DEFAULT 0
    CHECK(generation BETWEEN 0 AND 9007199254740991);
  CREATE TRIGGER team_selection_generation AFTER UPDATE OF revision_id ON team_selections
    BEGIN UPDATE team_selections SET generation=OLD.generation+1 WHERE project_id=NEW.project_id; END;
  CREATE UNIQUE INDEX team_evidence_scope ON team_evidence(project_id,revision_id,id);
  CREATE TABLE team_approvals(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB))<=40960),
    created_at TEXT NOT NULL, UNIQUE(project_id,actor_id,operation_id), UNIQUE(project_id,revision_id,id),
    FOREIGN KEY(project_id,revision_id,evidence_id) REFERENCES team_evidence(project_id,revision_id,id)) STRICT;
  CREATE TABLE team_activations(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, approval_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
    actor_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB))<=40960),
    created_at TEXT NOT NULL, UNIQUE(project_id,generation), UNIQUE(project_id,actor_id,operation_id),
    FOREIGN KEY(project_id,revision_id,approval_id) REFERENCES team_approvals(project_id,revision_id,id)) STRICT;
  CREATE TRIGGER team_approval_immutable BEFORE UPDATE ON team_approvals
    BEGIN SELECT RAISE(ABORT,'Team approval is immutable'); END;
  CREATE TRIGGER team_activation_immutable BEFORE UPDATE ON team_activations
    BEGIN SELECT RAISE(ABORT,'Team activation is immutable'); END;
  CREATE TRIGGER team_approval_operation BEFORE INSERT ON team_approvals
    WHEN EXISTS(SELECT 1 FROM team_activations WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'Team operation already exists'); END;
  CREATE TRIGGER team_activation_operation BEFORE INSERT ON team_activations
    WHEN EXISTS(SELECT 1 FROM team_approvals WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(ABORT,'Team operation already exists'); END;
`;
export const addTeamCapabilities = `
  ALTER TABLE team_revisions ADD COLUMN source_bundle TEXT
    CHECK(source_bundle IS NULL OR (json_valid(source_bundle) AND length(CAST(source_bundle AS BLOB))<=262144));
  CREATE TRIGGER team_source_immutable BEFORE UPDATE OF source_bundle ON team_revisions
    WHEN NEW.source_bundle IS NOT OLD.source_bundle
    BEGIN SELECT RAISE(ABORT,'Team source is immutable'); END;
  CREATE TABLE team_drafts(
    project_id TEXT PRIMARY KEY REFERENCES projects(id), draft_version INTEGER NOT NULL DEFAULT 0
      CHECK(draft_version BETWEEN 0 AND 9007199254740991), revision_id TEXT,
    FOREIGN KEY(project_id,revision_id) REFERENCES team_revisions(project_id,revision_id)) STRICT;
  INSERT INTO team_drafts(project_id) SELECT id FROM projects WHERE mode='TEAM';
  CREATE TABLE team_evidence(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    executable_identity TEXT NOT NULL, case_digest TEXT NOT NULL, harness TEXT NOT NULL,
    cases TEXT NOT NULL CHECK(json_valid(cases) AND length(CAST(cases AS BLOB))<=32768),
    report TEXT NOT NULL CHECK(json_valid(report) AND length(CAST(report AS BLOB))<=262144),
    passed INTEGER NOT NULL CHECK(passed IN (0,1)), created_at TEXT NOT NULL,
    FOREIGN KEY(project_id,revision_id) REFERENCES team_revisions(project_id,revision_id)) STRICT;
  CREATE INDEX team_evidence_revision ON team_evidence(project_id,revision_id,created_at,id);
  CREATE TRIGGER team_evidence_immutable BEFORE UPDATE ON team_evidence
    BEGIN SELECT RAISE(ABORT,'Team evidence is immutable'); END;
`;
export const addTeamProjects = `
  ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'PERSONAL' CHECK(mode IN ('PERSONAL','TEAM'));
  ALTER TABLE tasks ADD COLUMN creator_id TEXT REFERENCES users(id);
  ALTER TABLE tasks ADD COLUMN assignee_id TEXT REFERENCES users(id);
  ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
  ALTER TABLE tasks ADD COLUMN origin_event_id TEXT REFERENCES team_admissions(event_id);
  CREATE TABLE project_members(
    project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK(role IN ('ADMIN','MEMBER')), PRIMARY KEY(project_id,user_id)) STRICT;
  CREATE TABLE team_revisions(
    project_id TEXT NOT NULL REFERENCES projects(id), revision_id TEXT NOT NULL,
    manifest TEXT NOT NULL CHECK(json_valid(manifest) AND length(CAST(manifest AS BLOB))<=32768),
    artifacts TEXT NOT NULL CHECK(json_valid(artifacts) AND length(CAST(artifacts AS BLOB))<=2097152),
    revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=0),
    PRIMARY KEY(project_id,revision_id)) STRICT;
  CREATE TABLE team_selections(
    project_id TEXT PRIMARY KEY REFERENCES projects(id), revision_id TEXT,
    FOREIGN KEY(project_id,revision_id) REFERENCES team_revisions(project_id,revision_id)) STRICT;
  CREATE TABLE team_admissions(
    event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    source_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), initiator_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL, original_key TEXT NOT NULL UNIQUE, revision_id TEXT,
    policy_state TEXT NOT NULL CHECK(policy_state IN ('NO_POLICY','PINNED')),
    manifest TEXT CHECK(manifest IS NULL OR (json_valid(manifest) AND length(CAST(manifest AS BLOB))<=32768)),
    state TEXT NOT NULL CHECK(state IN ('NO_HOOK','PENDING','STARTED','CLOSED')),
    claim TEXT, outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=131072)),
    receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(CAST(receipt AS BLOB))<=16384)),
    child_id TEXT UNIQUE REFERENCES tasks(id),
    observation TEXT CHECK(observation IS NULL OR (json_valid(observation) AND length(CAST(observation AS BLOB))<=32768)),
    created_at TEXT NOT NULL, UNIQUE(initiator_id,operation_id),
    FOREIGN KEY(project_id,revision_id) REFERENCES team_revisions(project_id,revision_id),
    CHECK((policy_state='NO_POLICY' AND revision_id IS NULL AND manifest IS NULL AND state='NO_HOOK')
      OR (policy_state='PINNED' AND revision_id IS NOT NULL AND manifest IS NOT NULL)),
    CHECK((state IN ('NO_HOOK','PENDING') AND claim IS NULL) OR (state IN ('STARTED','CLOSED') AND claim IS NOT NULL)),
    CHECK(child_id IS NULL OR receipt IS NOT NULL)) STRICT;
  CREATE INDEX team_children ON tasks(project_id,parent_task_id,origin_event_id);
  CREATE TRIGGER team_revision_immutable BEFORE UPDATE ON team_revisions
    WHEN NEW.project_id IS NOT OLD.project_id OR NEW.revision_id IS NOT OLD.revision_id
      OR NEW.manifest IS NOT OLD.manifest OR NEW.artifacts IS NOT OLD.artifacts
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
    BEGIN SELECT RAISE(ABORT,'Team revision is immutable'); END;
  CREATE TRIGGER team_task_origin_immutable BEFORE UPDATE ON tasks
    WHEN NEW.creator_id IS NOT OLD.creator_id OR NEW.parent_task_id IS NOT OLD.parent_task_id
      OR NEW.origin_event_id IS NOT OLD.origin_event_id
    BEGIN SELECT RAISE(ABORT,'Task origin is immutable'); END;
  CREATE TRIGGER team_admission_immutable BEFORE UPDATE ON team_admissions
    WHEN NEW.event_id IS NOT OLD.event_id OR NEW.project_id IS NOT OLD.project_id
      OR NEW.source_task_id IS NOT OLD.source_task_id OR NEW.initiator_id IS NOT OLD.initiator_id
      OR NEW.operation_id IS NOT OLD.operation_id OR NEW.original_key IS NOT OLD.original_key
      OR NEW.revision_id IS NOT OLD.revision_id OR NEW.policy_state IS NOT OLD.policy_state
      OR NEW.manifest IS NOT OLD.manifest OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.claim IS NOT NULL AND NEW.claim IS NOT OLD.claim)
      OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
      OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
      OR (OLD.child_id IS NOT NULL AND NEW.child_id IS NOT OLD.child_id)
      OR (NEW.state IS NOT OLD.state AND NOT
        ((OLD.state='PENDING' AND NEW.state='STARTED') OR (OLD.state='STARTED' AND NEW.state='CLOSED')))
    BEGIN SELECT RAISE(ABORT,'Team admission and receipt are immutable'); END;
`;

export function projectAccess(db, actor, id, admin = false) {
  const row = db.prepare(`SELECT p.*,m.role FROM projects p LEFT JOIN project_members m
    ON m.project_id=p.id AND m.user_id=? WHERE p.id=?`).get(actor, id);
  if (!row || (row.mode === 'PERSONAL' ? row.owner_id !== actor : !row.role)) throw notFound();
  if (admin && row.mode === 'TEAM' && row.role !== 'ADMIN') throw new AppError(403, 'Only a project admin can change this.');
  return row;
}

export function taskAccess(db, actor, id, write = false) {
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw notFound();
  const project = projectAccess(db, actor, row.project_id);
  if (row.owner_id !== project.owner_id) throw notFound();
  if (write && project.mode === 'TEAM' && project.role !== 'ADMIN'
      && (row.assignee_id ? row.assignee_id !== actor : row.creator_id !== actor))
    throw new AppError(403, 'Only the assignee, task creator or project admin can change this task.');
  return { row, project };
}

export function admitTeamRoot(db, actor, taskId, operationId, now) {
  const { row, project } = taskAccess(db, actor, taskId);
  const selected = db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(project.id);
  if (!selected) throw new AppError(503, 'This Team project has no policy selection record.');
  const revision = selected.revision_id === null ? null
    : db.prepare('SELECT * FROM team_revisions WHERE project_id=? AND revision_id=?').get(project.id, selected.revision_id);
  if (selected.revision_id !== null && (!revision || revision.revoked_at !== null))
    throw new AppError(503, 'The selected Team policy is unavailable.');
  let manifest;
  if (revision) {
    manifest = JSON.parse(revision.manifest);
    if (!Object.hasOwn(manifest, 'TaskCreated') || !Object.hasOwn(manifest, 'TaskBeforeComplete'))
      throw new AppError(503, 'The selected Team policy is incomplete.');
  }
  if (row.creator_id !== actor) throw notFound();
  db.prepare(`INSERT INTO team_admissions(event_id,project_id,source_task_id,initiator_id,operation_id,original_key,
    revision_id,policy_state,manifest,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), project.id, row.id, actor, operationId, randomUUID(), revision?.revision_id ?? null,
      revision ? 'PINNED' : 'NO_POLICY', revision?.manifest ?? null,
      revision && manifest.TaskCreated !== null ? 'PENDING' : 'NO_HOOK', now);
}

export function verifiedChild(db, row) {
  if (!row.parent_task_id || !row.origin_event_id) return false;
  const saved = db.prepare(`SELECT a.*,p.project_id AS parent_project,p.parent_task_id AS parent_parent
    FROM team_admissions a JOIN tasks p ON p.id=a.source_task_id
    WHERE a.event_id=? AND a.source_task_id=? AND a.project_id=? AND a.child_id=?`)
    .get(row.origin_event_id, row.parent_task_id, row.project_id, row.id);
  if (!saved || saved.parent_project !== row.project_id || saved.parent_parent !== null) return false;
  try {
    const receipt = JSON.parse(saved.receipt);
    return receipt.effect === 'CONFIRMED' && receipt.result?.value?.id === row.id
      && receipt.originalKey === saved.original_key && receipt.eventId === saved.event_id;
  } catch { return false; }
}

// Human project management stays separate from policy selection and execution.
export function teamProjectService(db) {
  const member = (project, user) => db.prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?').get(project, user);
  function access(actor, projectId, admin = false, authorize) {
    if (authorize && authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
    const project = projectAccess(db, actor, projectId, admin);
    if (project.mode !== 'TEAM') throw notFound();
    return project;
  }
  function members(actor, projectId) {
    const project = access(actor, projectId);
    return { project: { id: project.id, name: project.name, mode: project.mode, role: project.role },
      members: db.prepare(`SELECT u.id,u.name,m.role FROM project_members m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=? ORDER BY m.role,u.name,u.id`).all(projectId) };
  }
  return {
    members,
    addMember(actor, projectId, input, authorize) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || typeof input.userId !== 'string') throw new AppError(400, 'Choose one existing demo person.');
      return transaction(db, () => {
        access(actor, projectId, true, authorize);
        if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(input.userId)) throw notFound();
        db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES (?,?,'MEMBER') ON CONFLICT DO NOTHING")
          .run(projectId, input.userId);
        access(actor, projectId, true, authorize);
        return members(actor, projectId);
      });
    },
    setSelection(actor, projectId, revisionId) {
      return transaction(db, () => {
        projectAccess(db, actor, projectId, true);
        if (revisionId !== null && !db.prepare('SELECT 1 FROM team_revisions WHERE project_id=? AND revision_id=? AND revoked_at IS NULL').get(projectId, revisionId))
          throw notFound();
        if (!db.prepare('UPDATE team_selections SET revision_id=? WHERE project_id=?').run(revisionId, projectId).changes) throw notFound();
      });
    },
    revoke(actor, projectId, revisionId) {
      return transaction(db, () => {
        projectAccess(db, actor, projectId, true);
        if (!db.prepare('UPDATE team_revisions SET revoked_at=coalesce(revoked_at,?) WHERE project_id=? AND revision_id=?').run(Date.now(), projectId, revisionId).changes)
          throw notFound();
        db.prepare('UPDATE team_selections SET revision_id=NULL WHERE project_id=? AND revision_id=?').run(projectId, revisionId);
      });
    },
    assign(actor, taskId, assigneeId) {
      return transaction(db, () => {
        const { row, project } = taskAccess(db, actor, taskId);
        projectAccess(db, actor, project.id, true);
        if (project.mode !== 'TEAM' || assigneeId !== null && !member(project.id, assigneeId)) throw notFound();
        db.prepare('UPDATE tasks SET assignee_id=? WHERE id=?').run(assigneeId, row.id);
      });
    },
    removeMember(actor, projectId, userId) {
      return transaction(db, () => {
        const project = projectAccess(db, actor, projectId, true), target = member(projectId, userId);
        if (project.mode !== 'TEAM' || !target) throw notFound();
        if (target.role === 'ADMIN' && db.prepare("SELECT count(*) AS n FROM project_members WHERE project_id=? AND role='ADMIN'").get(projectId).n <= 1)
          throw new AppError(409, 'Keep at least one project admin.');
        if (db.prepare(`SELECT 1 FROM tasks WHERE project_id=? AND status='open'
          AND (assignee_id=? OR (assignee_id IS NULL AND creator_id=?)) LIMIT 1`).get(projectId, userId, userId))
          throw new AppError(409, 'Reassign open work before removing this member.');
        db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, userId);
      });
    },
  };
}
