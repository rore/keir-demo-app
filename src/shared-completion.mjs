import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { AppError, appendTaskTag, openData, prepareSharedTaskCreate, readCustomizationTask, readOpenTaskMatch, taskDueAt, taskPriority, taskService, transaction, writeTaskSourceUpdate } from './data.mjs';
import { hostBindings, json, ownedProjectDefinitionId, SHARED_CREATED_UPDATE, SHARED_COMPLETED_UPDATE, SHARED_DUE_DEFINITION, SHARED_TAG_DEFINITION,
  combinedSourceUpdate, createdSourceUpdate, exactLookupUpdate, exactOwnedCreate, exactSourceUpdate, ownedSourceUpdate, sharedSourceUpdate, TASK_CREATED, TASK_HOOK } from './extension-catalog.mjs';
import { SHARED_MANIFEST, SHARED_CHECK, COMPLETION_GATE_CHECK, OWNED_GUARD_CHECK, exactTaskCheck, hasLookupCases, ownedProjectCheck, SAME_PROJECT,
  completionChecksPass } from './shared-completion-contract.mjs';
import { createTaskDecisionConsumer } from './task-effect-simulation.mjs';
import { projectAccess, taskAccess } from './team-native.mjs';
import { validOpenMatchInput } from './task-workflow-values.mjs';
import { COMPOSED_MANIFEST, TEAM_GATE_MANIFEST, isTaskBundle } from './shared-task-bundle.mjs';

const sharedFormat = format => format === SHARED_MANIFEST || isTaskBundle(format);
import { createTaskCreateGuard } from './task-create-guard.mjs';

const reject = (code, write) => ({ kind: 'BUSINESS_REJECTION', code, ...(write && { effect: 'NONE' }) });
const denied = () => new AppError(403, 'Shared task authority changed.');
const unavailable = () => new AppError(503, 'The exact shared completion binding is unavailable.');
const unknown = { kind: 'UNKNOWN_COMMIT', effect: 'UNKNOWN' };
const modelFor = host => JSON.parse(host.dcmBytes);
function verifiedGateChild(root, child) {
  const receipt = JSON.parse(root.receipt), args = receipt && JSON.parse(receipt.payload);
  return !!args && ['STARTED', 'CLOSED'].includes(root.state) && !!root.claim && root.child_id === child.id
    && receipt.capability === 'tasks.create' && receipt.effect === 'CONFIRMED' && receipt.result?.kind === 'SUCCESS'
    && receipt.result.effect === 'CONFIRMED' && receipt.result.value?.id === child.id
    && receipt.eventId === root.event_id && receipt.originalKey === root.original_key
    && receipt.projectId === root.project_id && child.project_id === root.project_id && child.creator_id === root.initiator_id
    && json(args) === receipt.payload && args.projectId === root.project_id
    && (args.parentTaskId ?? null) === child.parent_task_id && receipt.parentTaskId === child.parent_task_id
    && (!Object.hasOwn(args, 'assigneeId') || typeof args.assigneeId === 'string' && !!args.assigneeId)
    && (child.parent_task_id === null ? child.origin_event_id === null
      : child.parent_task_id === root.source_task_id && child.origin_event_id === root.event_id);
}
function updateFields(args, definitionId, current) {
  if (combinedSourceUpdate(definitionId)) {
    const names = Object.keys(args);
    if (!names.length || names.some(key => !['priority', 'dueAt', 'clearDue', 'addTag'].includes(key))
        || args.dueAt === null || Object.hasOwn(args, 'clearDue') && (args.clearDue !== true || Object.hasOwn(args, 'dueAt')))
      throw new AppError(400, 'Choose supported task updates and at most one due date operation.');
    return {
      ...(Object.hasOwn(args, 'priority') && { priority: taskPriority(args.priority) }),
      ...(Object.hasOwn(args, 'dueAt') && { dueAt: taskDueAt(args.dueAt) }),
      ...(args.clearDue === true && { dueAt: null }),
      ...(Object.hasOwn(args, 'addTag') && { tags: appendTaskTag(current.tags, args.addTag) }),
    };
  }
  if (Object.keys(args).length === 1) {
    if (Object.hasOwn(args, 'priority')) return { priority: taskPriority(args.priority) };
    if (definitionId === SHARED_DUE_DEFINITION || definitionId === SHARED_TAG_DEFINITION) {
      if (Object.hasOwn(args, 'dueAt') && args.dueAt !== null) return { dueAt: taskDueAt(args.dueAt) };
      if (args.clearDue === true) return { dueAt: null };
    }
    if (definitionId === SHARED_TAG_DEFINITION && Object.hasOwn(args, 'addTag'))
      return { tags: appendTaskTag(current.tags, args.addTag) };
  }
  throw new AppError(400, 'Choose exactly one supported task update.');
}
const updateReceiptVersion = definitionId => exactLookupUpdate(definitionId) ? '10' : exactSourceUpdate(definitionId) ? '8' : ownedSourceUpdate(definitionId) ? '7'
  : definitionId === SHARED_CREATED_UPDATE ? '5' : definitionId === SHARED_COMPLETED_UPDATE ? '6' : undefined;
function verifiedUpdate(row, saved, definitionId) {
  const change = saved?.observation?.updated;
  const version = updateReceiptVersion(definitionId);
  if (!change || saved.capability !== 'tasks.update' || row.created_task_id !== null
    || version && (saved.version !== version || !['STARTED', 'FINISHED'].includes(row.state))
    || saved.eventId !== row.id || saved.originalKey !== row.original_key || saved.projectId !== row.project_id
    || change.id !== row.source_id || saved.result?.value?.id !== row.source_id || saved.result?.kind !== 'SUCCESS'
    || saved.result.effect !== 'CONFIRMED') return false;
  try {
    const args = JSON.parse(saved.payload);
    return saved.payload === json(args) && json(change.after) === json({ ...change.before, ...updateFields(args, definitionId, change.before) });
  } catch { return false; }
}

function prepare(host, artifact, invoke) {
  const model = modelFor(host);
  const header = JSON.parse(artifact);
  if (header.entrypoint !== host.pins.hook || header.compiler !== host.pins.compiler) throw unavailable();
  const adapters = Object.fromEntries(Object.entries(model.capabilities).map(([id, cap]) => [id, {
    mode: 'real', keyType: model.hostKey.type, version: cap.version,
    invoke: (...args) => invoke(id, ...args),
  }]));
  const bound = bindModel(host.dcmBytes, adapters);
  if (!bound.boundModel || bound.diagnostic) throw unavailable();
  const program = prepareProgram(Buffer.from(artifact), bound.boundModel);
  if (!program.prepared || program.diagnostic) throw unavailable();
  return program.prepared;
}

async function runCompletionGate(binding, { actor, root, input, linked, check, deadline }) {
  const id = randomUUID(), key = Object.freeze({ type: modelFor(binding.host).hostKey.type, value: root.original_key });
  let observed = null, active = true;
  const program = prepare(binding.host, binding.artifact, async (capability, args, protectedArgs, remaining, invocation) => {
    try {
      check();
      if (!active || observed !== null || remaining <= 0 || protectedArgs.actorId !== actor
          || invocation.requestKey !== key || invocation.event.id !== id || invocation.event.source !== root.source_task_id
          || invocation.deadline.expiresAtMs !== deadline.expiresAtMs
          || capability !== 'tasks.linkedTask' || args.parentTaskId !== root.source_task_id || args.originEventId !== root.event_id) throw denied();
      observed = linked();
      return { kind: 'SUCCESS', value: { status: observed.status } };
    } catch { return reject('ACCESS_DENIED'); }
  });
  try {
    const outcome = await invokeProgram(program, input, { bindings: hostBindings(binding.artifact, actor), requestKey: key,
      event: { id, source: root.source_task_id }, deadline });
    check();
    return { outcome, result: createTaskDecisionConsumer(binding.host)(outcome).result, observed };
  } finally { active = false; }
}

// Native executor for the exact shared definitions; historical definitions keep their readers.
export function createSharedCompletion({ lifecycle, teamCapability, ...options }) {
  const { db } = options;
  const selectedTeamBinding = (project, rev, activation, manifest) => teamCapability.sharedCompletionBinding(project, rev, activation, manifest);
  const teamBinding = root => {
    const pin = db.prepare('SELECT activation_id FROM shared_completion_roots WHERE root_id=?').get(root.event_id);
    if (!pin || root.policy_state !== 'PINNED') throw unavailable();
    return selectedTeamBinding(root.project_id, root.revision_id, pin.activation_id, root.manifest);
  };
  return Object.freeze({
    ...completionExecutor({ ...options, personalBinding: row => isTaskBundle(JSON.parse(row.pins)?.format)
      ? lifecycle.pinnedTaskBundle(row) : lifecycle.sharedCompletionBinding(row), pinnedTeamBinding: teamBinding }),
    teamBinding,
    async beforeTeamComplete(actor, root, binding, { authority, deadline }) {
      const tasks = taskService(db), hasCreated = JSON.parse(root.manifest).hooks.TaskCreated !== null;
      const candidate = (status = 'open') => {
        authority(status);
        const { id, projectId, title, tags, priority, notes, dueAt } = tasks.getTask(actor, root.source_task_id);
        return { taskId: id, creationEventId: root.event_id, projectId, title, tags, priority, hasNotes: !!notes.trim(), hasDueDate: dueAt !== null };
      };
      const input = candidate(), snapshot = json(input);
      const linked = (status = 'open') => {
        authority(status);
        try {
          const fresh = db.prepare('SELECT state,claim,receipt,outcome,child_id FROM team_admissions WHERE event_id=?').get(root.event_id);
          if (!fresh.receipt && !fresh.child_id) {
            const outcome = fresh.outcome && JSON.parse(fresh.outcome);
            if (!hasCreated && fresh.state === 'NO_HOOK' && !fresh.claim && !fresh.outcome
                || hasCreated && fresh.state === 'CLOSED' && fresh.claim && outcome?.classification === 'COMPLETED'
                  && outcome.result?.status === 'NO_OP' && Array.isArray(outcome.effects) && !outcome.effects.length)
              return { status: 'MISSING' };
          } else if (hasCreated && fresh.receipt && fresh.child_id) {
            const { row: child } = taskAccess(db, actor, fresh.child_id);
            if (verifiedGateChild({ ...root, ...fresh }, child)) {
              if (child.parent_task_id === null) return { status: 'MISSING' };
              // Creation-time assignment is in the receipt. The live task can be reassigned by an admin.
              if (['open', 'completed'].includes(child.status) && (!child.assignee_id || db.prepare(
                'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(root.project_id, child.assignee_id)))
                return { status: child.status === 'open' ? 'OPEN' : 'COMPLETED', id: child.id, assigneeId: child.assignee_id };
            }
          }
        } catch { /* A malformed or unreadable receipt is not known absence. */ }
        throw new AppError(503, 'Daymark could not verify the linked task. The original is still open.');
      };
      const check = status => { if (json(candidate(status)) !== snapshot) throw new AppError(409, 'The task changed. Please try completing it again.'); };
      const { result, observed } = await runCompletionGate(binding, { actor, root, input, linked, check, deadline });
      if (!result || binding.usesLinkedTask && !observed) throw new AppError(503, 'Daymark could not verify the completion rule. The task is still open.');
      return { result, recheck(status) {
        check(status);
        if (observed && json(linked(status)) !== json(observed)) throw new AppError(409, 'The linked task changed. Please try completing the original again.');
      } };
    },
    personalCompletionPins: event => lifecycle.completionBundlePins(event),
    personalCompletionAdmission: (owner, before) => {
      const active = JSON.parse(before?.binding_pins ?? 'null');
      return active?.format === COMPOSED_MANIFEST && active.lifetimeCompletion ? lifecycle.completionAdmission(owner, before) : null;
    },
    verifyPersonalAdmission(selected) {
      const active = JSON.parse(selected.binding_pins);
      if (active.format === COMPOSED_MANIFEST && active.lifetimeCompletion)
        return lifecycle.completionAdmission(selected.owner_id, selected);
      lifecycle.selectedTaskBundle(selected.owner_id, selected);
      return null;
    },
    teamAdmission(projectId, revision, generation) {
      const active = db.prepare('SELECT id FROM team_activations WHERE project_id=? AND revision_id=? AND generation=?')
        .get(projectId, revision.revision_id, generation);
      if (!active) throw unavailable();
      selectedTeamBinding(projectId, revision.revision_id, active.id, revision.manifest);
      return active.id;
    },
  });
}

function completionExecutor({ db, guard, personalBinding, pinnedTeamBinding, clock = () => Math.floor(performance.now()), beforeWrite, writeReply,
  observedMatch, observedTask }, simulation, exampleBundle) {
  const root = taskId => db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(taskId);
  const personalEvent = id => db.prepare('SELECT * FROM task_events WHERE event_id=?').get(id);
  const receiptOf = row => row?.receipt ? JSON.parse(row.receipt) : null;
  const createdUpdate = (id, sourceId) => db.prepare('SELECT valid,receipt FROM shared_created_updates WHERE event_id=? AND source_id=?').get(id, sourceId);
  function createdReceipt(definitionId, id, sourceId, childId, receipt) {
    if (!createdSourceUpdate(definitionId)) return receipt;
    const update = createdUpdate(id, sourceId);
    if (!update?.receipt) return receipt;
    if (childId || receipt || update.valid !== 0) throw unavailable();
    return update.receipt;
  }
  function createdEvent(id) {
    const personal = personalEvent(id);
    const pins = JSON.parse(personal?.pins ?? 'null');
    if (personal?.hook_id === TASK_CREATED && isTaskBundle(pins?.format)) {
      const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(personal.source_task_id);
      const saved = db.prepare('SELECT * FROM shared_personal_created_receipts WHERE event_id=?').get(id);
      return { id, hook: TASK_CREATED, source_id: personal.source_task_id, project_id: task?.project_id,
        occurred_at: personal.created_at, actor_id: personal.owner_id, original_key: personal.original_key,
        personal_event_id: id, root_id: null, state: personal.state, outcome: personal.outcome,
        receipt: createdReceipt(pins.definitionId, id, personal.source_task_id, saved?.task_id, saved?.receipt),
        created_task_id: saved?.task_id ?? null, definition_id: pins.definitionId };
    }
    const team = db.prepare('SELECT * FROM team_admissions WHERE event_id=?').get(id);
    const manifest = JSON.parse(team?.manifest ?? 'null');
    if (!isTaskBundle(manifest?.format) || manifest.hooks.TaskCreated === null) return null;
    return { id, hook: TASK_CREATED, source_id: team.source_task_id, project_id: team.project_id,
      occurred_at: team.created_at, actor_id: team.initiator_id, original_key: team.original_key,
      personal_event_id: null, root_id: id, state: team.state === 'CLOSED' ? 'FINISHED' : team.state, outcome: team.outcome,
      receipt: createdReceipt(manifest.hooks.TaskCreated.definitionId, id, team.source_task_id, team.child_id, team.receipt),
      created_task_id: team.child_id, definition_id: manifest.hooks.TaskCreated.definitionId };
  }
  const event = id => db.prepare('SELECT * FROM shared_completion_events WHERE id=?').get(id) ?? createdEvent(id);
  function binding(row) {
    if (simulation) return simulation;
    if (row.personal_event_id) {
      const saved = personalEvent(row.personal_event_id);
      if (!saved || saved.revoked_at !== null || saved.owner_id !== row.actor_id || saved.source_task_id !== row.source_id
          || saved.original_key !== row.original_key || saved.created_at !== row.occurred_at || saved.state !== row.state
           || json(JSON.parse(saved.input)) !== json({ taskId: row.source_id, occurredAt: row.occurred_at })) throw unavailable();
      if ((row.hook ?? TASK_HOOK) !== saved.hook_id) throw unavailable();
      return personalBinding(saved);
    }
    const saved = root(row.source_id);
    if (!saved || saved.event_id !== row.root_id || saved.project_id !== row.project_id) throw unavailable();
    return pinnedTeamBinding(saved);
  }

  function capture(actor, taskId, now) {
    if (!db.isTransaction) throw unavailable();
    const { row, project } = taskAccess(db, actor, taskId, true);
    if (row.status !== 'completed' || row.completed_at !== now) throw denied();
    const team = project.mode === 'TEAM', attached = team ? root(taskId) : null;
    const personal = !team && db.prepare("SELECT * FROM task_events WHERE owner_id=? AND source_task_id=? AND hook_id='TaskCompleted'").get(actor, taskId);
    const manifest = JSON.parse((team ? attached?.manifest : personal?.pins) ?? 'null');
    if ((manifest?.format !== SHARED_MANIFEST && !isTaskBundle(manifest?.format)) || team && manifest.hooks?.TaskCompleted === null) return;
    db.prepare(`INSERT INTO shared_completion_events(id,original_key,source_id,actor_id,project_id,occurred_at,personal_event_id,root_id,state)
      VALUES (?,?,?,?,?,?,?,?,'PENDING')`).run(personal?.event_id ?? randomUUID(), personal?.original_key ?? randomUUID(),
      taskId, actor, project.id, now, personal?.event_id ?? null, attached?.event_id ?? null);
    if (sharedSourceUpdate(team ? manifest.hooks?.TaskCompleted?.definitionId : manifest.definitionId))
      db.prepare('INSERT INTO shared_priority_fences(source_id) VALUES (?)').run(taskId);
  }

  function verifiesReceipt(row, task) {
    if (!row) return false;
    if (row?.hook === TASK_CREATED && row.root_id) {
      const admission = root(row.source_id);
      if (JSON.parse(admission?.manifest ?? 'null')?.format === TEAM_GATE_MANIFEST) return verifiedGateChild(admission, task);
    }
    const receipt = receiptOf(row);
    if (receipt?.eventId !== row.id || receipt.originalKey !== row.original_key || receipt.capability !== 'tasks.create'
        || receipt.result?.kind !== 'SUCCESS' || receipt.result.effect !== 'CONFIRMED' || row.created_task_id !== task.id
        || receipt.result.value?.id !== task.id || receipt.projectId !== task.project_id || receipt.parentTaskId !== task.parent_task_id)
      return false;
    const hook = row?.hook ?? TASK_HOOK;
    const definitionId = row.definition_id ?? (row.personal_event_id && JSON.parse(personalEvent(row.personal_event_id)?.pins ?? 'null')?.definitionId);
    if (ownedSourceUpdate(definitionId) || exactSourceUpdate(definitionId)) return false;
    if (definitionId === ownedProjectDefinitionId(hook) || exactOwnedCreate(definitionId)) {
      const args = JSON.parse(receipt.payload);
      return receipt.version === (exactOwnedCreate(definitionId) ? '9' : '4') && row.root_id === null && ['STARTED', 'FINISHED'].includes(row.state)
        && row.actor_id === task.owner_id && task.creator_id === null && task.parent_task_id === null && task.origin_event_id === null
        && json(args) === receipt.payload && args?.projectId === receipt.projectId;
    }
    return !['4', '9'].includes(receipt.version) && (row.root_id === null ? task.creator_id === null : task.creator_id === row.actor_id
      && row.project_id === task.project_id && (task.parent_task_id === null || task.parent_task_id === row.source_id));
  }
  function verifiedCreatedTask(task) {
    const completed = db.prepare('SELECT * FROM shared_completion_events WHERE created_task_id=?').get(task.id);
    if (completed) return verifiesReceipt(completed, task);
    const saved = db.prepare('SELECT event_id FROM shared_personal_created_receipts WHERE task_id=?').get(task.id)
      ?? db.prepare('SELECT event_id,manifest FROM team_admissions WHERE child_id=?').get(task.id);
    if (!saved || saved.manifest && !isTaskBundle(JSON.parse(saved.manifest).format)) return false;
    if (!verifiesReceipt(createdEvent(saved.event_id), task)) throw unavailable();
    return true;
  }
  function reaction(actor, taskId, reconcile = false, hook = TASK_HOOK) {
    const { row: source, project } = taskAccess(db, actor, taskId), team = project.mode === 'TEAM';
    const personal = !team && db.prepare('SELECT * FROM task_events WHERE owner_id=? AND source_task_id=? AND hook_id=?')
      .get(actor, taskId, hook);
    const admission = team ? root(taskId) : personal;
    const row = hook === TASK_CREATED ? admission && createdEvent(admission.event_id)
      : db.prepare('SELECT * FROM shared_completion_events WHERE source_id=?').get(taskId);
    if (!row) {
      if (JSON.parse(personal?.pins ?? 'null')?.format === SHARED_MANIFEST) throw unavailable();
      return null;
    }
    if (row.project_id !== project.id || (hook === TASK_CREATED ? row.occurred_at !== source.created_at
      : source.status !== 'completed' || row.occurred_at !== source.completed_at)) throw unavailable();
    // Read the captured identity, not the current selection or current permission to execute.
    // A later revocation cannot erase an already committed receipt.
    if (!admission || (team ? !row.root_id || row.personal_event_id !== null || row.root_id !== admission.event_id
      || admission.project_id !== project.id || admission.policy_state !== 'PINNED' || !admission.revision_id
       || !sharedFormat(JSON.parse(admission.manifest)?.format)
      || !db.prepare(`SELECT 1 FROM shared_completion_roots p JOIN team_activations a ON a.id=p.activation_id
        WHERE p.root_id=? AND a.project_id=? AND a.revision_id=?`).get(row.root_id, project.id, admission.revision_id)
      : row.root_id !== null || row.actor_id !== actor || row.personal_event_id !== admission.event_id
      || row.id !== admission.event_id || row.original_key !== admission.original_key || row.state !== admission.state
      || row.occurred_at !== admission.created_at || !admission.revision_id
        || !sharedFormat(JSON.parse(admission.pins ?? 'null')?.format))) throw unavailable();
    let receipt = null, linked = false, details = {};
    if (row.created_task_id) {
      try {
        const created = taskAccess(db, actor, row.created_task_id);
        if (created.project.mode === project.mode && verifiesReceipt(row, created.row)) {
          const saved = receiptOf(row);
          receipt = saved.result;
          linked = created.row.parent_task_id === taskId;
          if (['4', '9'].includes(saved.version)) details = { destinationProjectId: created.project.id };
        }
      } catch { /* The viewer cannot resolve this result. */ }
    } else if (row.receipt) {
      const saved = receiptOf(row);
      const manifest = JSON.parse(team ? admission.manifest : admission.pins);
      const definitionId = hook === TASK_CREATED ? row.definition_id : team ? manifest.hooks?.TaskCompleted?.definitionId : manifest.definitionId;
      if (!(hook === TASK_CREATED ? createdSourceUpdate(definitionId) : sharedSourceUpdate(definitionId))
          || !verifiedUpdate(row, saved, definitionId)) throw unavailable();
      receipt = saved.result;
      details = { capability: saved.capability, observation: saved.observation };
    }
    const outcome = row.outcome && JSON.parse(row.outcome);
    if (!receipt && outcome?.effects?.some(effect => effect.capability === 'tasks.update')) details = { capability: 'tasks.update' };
    return { state: row.state, revisionId: admission.revision_id,
      eventId: row.id, originalKey: row.original_key,
      outcome, receipt, linked, team, workflow: true, ...details,
      ...(!team && admission.revoked_at !== null && { revoked: true }),
      ...(reconcile && { reconciliation: { observedAt: new Date().toISOString(), receipt, ...details } }) };
  }
  function status(actor, taskId) {
    return reaction(actor, taskId) ?? { state: 'NO_BINDING', outcome: null, receipt: null };
  }

  async function run(id) {
    const row = event(id);
    if (row?.state !== 'PENDING') return false; // Never claim a STARTED or FINISHED attempt, including after restart.
    const admitted = binding(row), hook = row.hook ?? simulation?.hook ?? TASK_HOOK;
    const { host, artifact, manifest } = admitted.bindings?.[hook] ?? admitted, team = manifest.scope === 'TEAM';
    const onCreate = hook === TASK_CREATED, nativeCreated = row.hook === TASK_CREATED;
    const definitionId = host.pins.definitionId;
    const updatesOnCreate = onCreate && createdSourceUpdate(definitionId);
    const updatesOnComplete = host.pins.definitionId === SHARED_COMPLETED_UPDATE;
    const exactCreate = exactOwnedCreate(definitionId);
    const owned = exactCreate || exactLookupUpdate(definitionId) || definitionId === ownedProjectDefinitionId(hook) || ownedSourceUpdate(definitionId);
    const exact = exactCreate || exactSourceUpdate(definitionId);
    const claim = nativeCreated && team ? randomUUID() : null;
    if (hook !== host.pins.hook) throw unavailable();
    const key = Object.freeze({ type: modelFor(host).hostKey.type, value: row.original_key });
    const source = { id, source: row.source_id }, actor = row.actor_id;
    const started = clock(), deadline = { clock: { nowMs: clock }, expiresAtMs: started + 1000 };
    if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(deadline.expiresAtMs)) throw unavailable();
    let active = true, lastNow = started;
    const reads = new Map(), matches = new Map();
    function authority() {
      const now = clock();
      if (!active || !Number.isSafeInteger(now) || now < lastNow || now >= deadline.expiresAtMs || event(id)?.state !== 'STARTED'
          || claim && root(row.source_id)?.claim !== claim) throw denied();
      lastNow = now;
      const { row: task, project } = taskAccess(db, actor, row.source_id, true);
      if ((onCreate ? task.created_at !== row.occurred_at
        : task.status !== 'completed' || task.completed_at !== row.occurred_at) || project.id !== row.project_id
          || project.mode !== (team ? 'TEAM' : 'PERSONAL')) throw denied();
      try { binding(event(id)); } catch { throw denied(); }
      return { task, project };
    }
    function projectInScope(projectId) {
      const next = projectAccess(db, actor, projectId);
      if (team ? next.mode !== 'TEAM' || next.id !== row.project_id : next.mode !== 'PERSONAL') throw denied();
      return next;
    }
    function read(taskId) {
      const { project } = taskAccess(db, actor, taskId);
      projectInScope(project.id);
      const { status, dueAt, ...task } = readCustomizationTask(db, project.owner_id, taskId, project.id);
      return { ...task, status: status === 'open' ? 'OPEN' : 'COMPLETED', ...(dueAt !== null && { dueAt }) };
    }
    function openMatch(projectId, title) {
      const { project } = authority();
      if ((!owned && projectId !== project.id) || !validOpenMatchInput(projectId, title)) throw denied();
      return readOpenTaskMatch(db, owned ? projectInScope(projectId) : project, title, authority);
    }
    function placement(args) {
      const { task } = authority(), target = projectInScope(args.projectId);
      if (!owned && target.id !== row.project_id) throw denied();
      const parent = args.parentTaskId, assignee = args.assigneeId;
      if (!team && (parent !== undefined || assignee !== undefined)
          || parent !== undefined && (parent !== task.id || task.parent_task_id !== null)
          || assignee !== undefined && !db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(target.id, assignee))
        throw denied();
      return target;
    }
    const prepared = prepare(host, artifact, async (capability, args, protectedArgs, remaining, invocation) => {
      const update = capability === 'tasks.update', write = update || capability === 'tasks.create';
      let committed = false;
      try {
        if (protectedArgs.actorId !== actor || remaining <= 0 || invocation.requestKey !== key
            || invocation.event.id !== id || invocation.event.source !== row.source_id
            || invocation.deadline.expiresAtMs !== deadline.expiresAtMs) throw denied();
        authority();
        if (capability === 'tasks.get') {
          if ((!exact && owned || updatesOnComplete) && args.taskId !== row.source_id) throw denied();
          const value = read(args.taskId), snapshot = json(value);
          if (reads.has(args.taskId) && reads.get(args.taskId) !== snapshot) throw denied();
          reads.set(args.taskId, snapshot);
          if (exact && args.taskId !== row.source_id) observedTask?.({ dueAt: null, ...value });
          return { kind: 'SUCCESS', value };
        }
        if (capability === 'tasks.openMatch') {
          const value = openMatch(args.projectId, args.title);
          const key = json([args.projectId, args.title]);
          if (matches.has(key) && matches.get(key) !== value.matches) throw denied();
          matches.set(key, value.matches);
          observedMatch?.({ ...(owned && { projectId: args.projectId }), title: args.title, matches: value.matches });
          return { kind: 'SUCCESS', value };
        }
        if (!write) throw unavailable();
        const payload = json(args);
        if (update) {
          await beforeWrite?.({ eventId: id });
          const result = transaction(db, () => {
            const { task, project } = authority();
            const protection = updatesOnCreate && createdUpdate(id, task.id);
            const prior = protection ? protection.receipt && JSON.parse(protection.receipt) : receiptOf(event(id));
            if (prior) return prior.capability === capability && prior.payload === payload ? prior.result : reject('KEY_PAYLOAD_MISMATCH', true);
            if (updatesOnCreate ? protection?.valid !== 1 || task.status !== 'open'
              || (team ? task.creator_id !== actor : task.owner_id !== actor) || task.parent_task_id !== null
              : !db.prepare('SELECT 1 FROM shared_priority_fences WHERE source_id=?').get(task.id)) throw denied();
            recheckReads();
            const before = { priority: task.priority, tags: JSON.parse(task.tags), dueAt: task.due_at };
            const fields = updateFields(args, host.pins.definitionId, before);
            const after = { ...before, ...fields };
            writeTaskSourceUpdate(db, task, before, after);
            const result = { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: task.id } };
            const version = updateReceiptVersion(definitionId);
            const receipt = { eventId: id, originalKey: row.original_key, capability, payload, result, projectId: project.id,
              observation: { updated: { id: task.id, before, after } },
              ...(version && { version }) };
            const written = updatesOnCreate
              ? db.prepare('UPDATE shared_created_updates SET valid=0,receipt=? WHERE event_id=? AND source_id=? AND receipt IS NULL')
                .run(json(receipt), id, task.id)
              : db.prepare("UPDATE shared_completion_events SET receipt=? WHERE id=? AND state='STARTED' AND receipt IS NULL").run(json(receipt), id);
            if (written.changes !== 1) throw denied();
            authority();
            return result;
          });
          committed = result.effect === 'CONFIRMED';
          return writeReply ? await writeReply(result) : result;
        }
        const target = placement(args);
        // The existing Personal gate uses its own exact model key type, not the shared event's dispatch key.
        const bundle = exampleBundle ?? (admitted.bindings ? admitted : null);
        const mutation = await prepareSharedTaskCreate(db, actor, target, args, guard, { deadline,
          ...(nativeCreated && team && admitted.manifest.format === TEAM_GATE_MANIFEST && args.parentTaskId && { originEventId: id }),
          ...(bundle && { pinnedBeforeCreate: bundle.manifest.hooks.TaskBeforeCreate === null ? null : () => {
            authority();
            return (exampleBundle ?? binding(event(id))).bindings.TaskBeforeCreate;
          } }),
          requestKey: Object.freeze({ type: 'demo.TaskWorkflowKey/1', value: row.original_key }) });
        await beforeWrite?.({ eventId: id });
        const result = transaction(db, () => {
          const currentTarget = placement(args), prior = receiptOf(event(id));
          if (prior) return prior.capability === capability && prior.payload === payload ? prior.result : reject('KEY_PAYLOAD_MISMATCH', true);
          recheckReads();
          if (currentTarget.owner_id !== target.owner_id) throw denied();
          const taskId = mutation.insert();
          const result = { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: taskId } };
          const receipt = { eventId: id, originalKey: row.original_key, capability, payload, result,
            projectId: target.id, parentTaskId: args.parentTaskId ?? null, ...(owned && { version: exactCreate ? '9' : '4' }) };
          const written = nativeCreated ? team
            ? db.prepare("UPDATE team_admissions SET receipt=?,child_id=? WHERE event_id=? AND state='STARTED' AND claim=? AND receipt IS NULL")
              .run(json({ ...receipt, effect: 'CONFIRMED' }), taskId, id, claim)
            : db.prepare('INSERT INTO shared_personal_created_receipts VALUES (?,?,?)').run(id, taskId, json(receipt))
            : db.prepare("UPDATE shared_completion_events SET receipt=?,created_task_id=? WHERE id=? AND state='STARTED' AND receipt IS NULL")
              .run(json(receipt), taskId, id);
          if (written.changes !== 1) throw denied();
          mutation.checkCommit();
          placement(args);
          // A create can satisfy its own lookup; only recheck project access after insertion.
          if (owned) for (const key of matches.keys()) projectInScope(JSON.parse(key)[0]);
          return result;
        });
        committed = result.effect === 'CONFIRMED';
        return writeReply ? await writeReply(result) : result;
      } catch (error) {
        if (committed) return unknown;
        if (error.code === 'TASK_CREATE_DENIED' || error.status === 400) return reject('TASK_INVALID', write);
        if (['TASK_CREATE_STALE', 'TASK_CREATE_UNAVAILABLE'].includes(error.code)) return { kind: 'TRANSIENT_FAILURE', effect: 'NONE' };
        if (error.status === 403) return reject('ACCESS_DENIED', write);
        if (error.status === 404) return reject(capability === 'tasks.create' || capability === 'tasks.openMatch' ? 'PROJECT_NOT_FOUND' : 'TASK_NOT_FOUND', write);
        return write ? unknown : { kind: 'TRANSIENT_FAILURE' };
      }
    });
    function recheckReads() {
      for (const [taskId, snapshot] of reads) if (json(read(taskId)) !== snapshot) throw denied();
      for (const [key, matched] of matches) if (openMatch(...JSON.parse(key)).matches !== matched) throw denied();
    }
    if (!transaction(db, () => {
      if (event(id)?.state !== 'PENDING') return false;
      binding(event(id));
      if (nativeCreated && team) {
        if (db.prepare("UPDATE team_admissions SET state='STARTED',claim=? WHERE event_id=? AND state='PENDING'").run(claim, id).changes !== 1) throw unavailable();
      } else if (!nativeCreated && db.prepare("UPDATE shared_completion_events SET state='STARTED' WHERE id=? AND state='PENDING'").run(id).changes !== 1)
        throw unavailable();
      if (row.personal_event_id && db.prepare("UPDATE task_events SET state='STARTED' WHERE event_id=? AND state='PENDING' AND revoked_at IS NULL")
        .run(row.personal_event_id).changes !== 1) throw unavailable();
      return true;
    })) return false;
    try {
      const outcome = await invokeProgram(prepared, { taskId: row.source_id, occurredAt: row.occurred_at },
        { bindings: hostBindings(artifact, actor), requestKey: key, event: source, deadline });
      transaction(db, () => {
        if (nativeCreated && team)
          db.prepare("UPDATE team_admissions SET state='CLOSED',outcome=? WHERE event_id=? AND state='STARTED' AND claim=?").run(json(outcome), id, claim);
        else if (!nativeCreated)
          db.prepare("UPDATE shared_completion_events SET state='FINISHED',outcome=? WHERE id=? AND state='STARTED'").run(json(outcome), id);
        if (row.personal_event_id) db.prepare("UPDATE task_events SET state='FINISHED',outcome=? WHERE event_id=? AND state='STARTED'")
          .run(json(outcome), row.personal_event_id);
        if (sharedSourceUpdate(host.pins.definitionId))
          db.prepare('DELETE FROM shared_priority_fences WHERE source_id=?').run(row.source_id);
        if (updatesOnCreate) db.prepare('UPDATE shared_created_updates SET valid=0 WHERE event_id=? AND valid=1').run(id);
      });
      return true;
    } finally { active = false; }
  }
  return Object.freeze({ capture, verifiedCreatedTask, run, status, reaction });
}

function seedExampleReads(db, actor, now, sourceProject, referenceTasks, openProjects = []) {
  const ids = new Set([...referenceTasks.map(task => task.projectId), ...openProjects.map(p => p.projectId)]);
  ids.delete(sourceProject);
  for (const id of ids) db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,?,'Example project',?,?,'PERSONAL')")
    .run(id, actor, now, now);
  const insert = db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at,tags,priority,due_at)
    VALUES (?,?,?,?,'',?,?,?,?,?,?,?)`);
  for (const task of referenceTasks) {
    const complete = task.status === 'COMPLETED';
    insert.run(task.id, actor, task.projectId, task.title, complete ? 'completed' : 'open', now, now,
      complete ? now : null, json(task.tags), task.priority, task.dueAt);
  }
  for (const p of openProjects) for (const title of p.titles) insert.run(randomUUID(), actor, p.projectId, title, 'open',
    now, now, null, '[]', 'normal', null);
}

export async function checkSharedCompletion(binding, revisionId, actor, members, check, exampleBundle) {
  if (binding.harness === COMPLETION_GATE_CHECK) {
    const checks = [], clock = { nowMs: () => Math.floor(performance.now()) };
    for (const { id, expect, linkedStatus, ...fields } of binding.cases) {
      check();
      const root = { event_id: randomUUID(), original_key: randomUUID(), source_task_id: randomUUID() };
      const { result, outcome, observed } = await runCompletionGate(binding, { actor, root,
        input: { ...fields, taskId: root.source_task_id, creationEventId: root.event_id },
        linked: () => { if (linkedStatus === null) throw unavailable(); return { status: linkedStatus }; },
        check, deadline: { clock, expiresAtMs: clock.nowMs() + 900 } });
      checks.push({ id, classification: outcome.classification, effect: result ? 'NONE' : 'UNVERIFIED',
        branch: result?.decision ?? 'UNVERIFIED', observed: result ?? null, linkedStatus: observed?.status ?? null });
    }
    return { harness: binding.harness, revisionId, executableIdentity: binding.executableIdentity, caseDigest: binding.manifest.caseDigest,
      checks, passed: completionChecksPass(binding, checks) };
  }
  const checks = [], team = binding.manifest.scope === 'TEAM';
  if (binding.hook === 'TaskBeforeCreate') {
    const consume = createTaskDecisionConsumer(binding.host);
    const clock = { nowMs: () => Math.floor(performance.now()) };
    const owned = binding.harness === OWNED_GUARD_CHECK;
    for (const { id, expect, openTitles = [], referenceTasks, openProjects, ...input } of binding.cases) {
      check();
      const db = openData(':memory:', { seed: false }), openMatches = [], taskReads = [];
      try {
        const project = { id: input.projectId, owner_id: actor, mode: binding.manifest.scope };
        const now = '2026-01-01T00:00:00.000Z';
        db.prepare("INSERT INTO users VALUES (?,'Example person')").run(actor);
        db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,?,'Example project',?,?,?)")
          .run(project.id, actor, now, now, project.mode);
        if (owned) seedExampleReads(db, actor, now, project.id, referenceTasks, openProjects);
        for (const title of openTitles) db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at)
          VALUES (?,?,?,?,'','open',?,?)`).run(randomUUID(), actor, project.id, title, now, now);
        const program = prepare(binding.host, binding.artifact, async (capability, args, protectedArgs) => {
          if (protectedArgs.actorId !== actor) return reject('ACCESS_DENIED');
          if (owned && capability === 'tasks.get') {
            try {
              const { status, dueAt, ...task } = readCustomizationTask(db, actor, args.taskId);
              const value = { ...task, status: status === 'open' ? 'OPEN' : 'COMPLETED' };
              taskReads.push({ ...value, dueAt });
              return { kind: 'SUCCESS', value: { ...value, ...(dueAt !== null && { dueAt }) } };
            } catch { return reject('TASK_NOT_FOUND'); }
          }
          if (capability !== 'tasks.openMatch' || !owned && args.projectId !== project.id
              || !validOpenMatchInput(args.projectId, args.title)) return reject('ACCESS_DENIED');
          try {
            const value = readOpenTaskMatch(db, { ...project, id: args.projectId }, args.title, check);
            openMatches.push({ ...(owned && { projectId: args.projectId }), title: args.title, matches: value.matches });
            return { kind: 'SUCCESS', value };
          } catch (error) {
            if (!owned || error.status !== 404) throw error;
            return reject('PROJECT_NOT_FOUND');
          }
        });
        const outcome = await invokeProgram(program, input, { bindings: hostBindings(binding.artifact, actor),
          requestKey: Object.freeze({ type: 'demo.TaskWorkflowKey/1', value: randomUUID() }),
          event: { id: randomUUID(), source: input.projectId }, deadline: { clock, expiresAtMs: clock.nowMs() + 900 } });
        const { result } = consume(outcome);
        checks.push({ id, classification: outcome.classification, effect: result ? 'NONE' : 'UNVERIFIED',
          branch: result?.decision ?? 'UNVERIFIED', observed: result ?? null, openMatches, ...(owned && { taskReads }) });
      } finally { db.close(); }
    }
    check();
    return { harness: binding.harness, revisionId, executableIdentity: binding.executableIdentity,
      caseDigest: binding.manifest.caseDigest, checks, passed: completionChecksPass(binding, checks) };
  }
  const lookup = hasLookupCases(binding.harness), full = lookup || binding.harness === SHARED_CHECK;
  const owned = ownedProjectCheck(binding.harness);
  const exact = exactTaskCheck(binding.harness);
  const createdExample = binding.hook === TASK_CREATED;
  const update = binding.write?.capability === 'tasks.update';
  const combinedUpdate = update && combinedSourceUpdate(binding.host.pins.definitionId);
  const createdUpdate = combinedUpdate && createdExample;
  const updateDue = update && (Object.hasOwn(binding.write.args, 'dueAt') || Object.hasOwn(binding.write.args, 'clearDue'));
  const updateTags = update && Object.hasOwn(binding.write.args, 'addTag');
  for (const c of binding.cases) {
    check();
    const project = c.projectId ?? (team ? binding.manifest.subject : 'example-personal-project');
    const db = openData(':memory:', { seed: false });
    const guard = exampleBundle && createTaskCreateGuard({ db, commitReserveMs: 100 });
    try {
      for (const id of new Set([actor, ...members])) db.prepare('INSERT INTO users(id,name) VALUES (?,?)').run(id, 'Example person');
      db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,?,'Example project',?,?,?)")
        .run(project, actor, c.occurredAt, c.occurredAt, binding.manifest.scope);
      if (owned && !exact) for (const { projectId } of c.openProjects) if (projectId !== project)
        db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,?,'Example project',?,?,'PERSONAL')")
          .run(projectId, actor, c.occurredAt, c.occurredAt);
      if (team) for (const id of new Set([actor, ...members])) db.prepare('INSERT INTO project_members VALUES (?,?,?)')
        .run(project, id, id === actor ? 'ADMIN' : 'MEMBER');
      else db.prepare("INSERT INTO extension_selections(owner_id,hook_id,generation) VALUES (?,'TaskBeforeCreate',0)").run(actor);
      const task = randomUUID(), event = randomUUID(), key = randomUUID(), item = randomUUID();
      db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at,tags,creator_id,priority)
        VALUES (?,?,?,?,'',?,?,?,?,?,?,?)`).run(task, actor, project, c.title, createdExample ? 'open' : 'completed',
        c.occurredAt, c.occurredAt, createdExample ? null : c.occurredAt, json(c.tags), team ? actor : null, c.priority ?? 'normal');
      let startingCount = 1;
      const openMatches = [], taskReads = [];
      if (exact) {
        seedExampleReads(db, actor, c.occurredAt, project, c.referenceTasks, c.openProjects);
        startingCount += c.referenceTasks.length + (c.openProjects?.reduce((count, p) => count + p.titles.length, 0) ?? 0);
      }
      for (const { projectId, titles } of exact ? [] : c.openProjects ?? [{ projectId: project, titles: c.openTitles ?? [] }])
        for (const title of titles) {
          db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at)
            VALUES (?,?,?,?,'','open',?,?)`).run(randomUUID(), actor, projectId, title, c.occurredAt, c.occurredAt);
          startingCount++;
        }
      // Only the disposable DB needs a synthetic event reference. No synthetic approval or live data is passed to the executor.
      const hook = createdExample ? TASK_CREATED : TASK_HOOK;
      db.prepare("INSERT INTO extensions(id,owner_id,hook_id,name,created_at,draft_version) VALUES (?,?,?,'Example',0,0)").run(item, actor, hook);
      db.prepare("INSERT INTO extension_revisions VALUES (?,?,'authored',?,'customer')").run(revisionId, actor, json(binding.manifest));
      db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, actor, item);
      db.prepare(`INSERT INTO task_events(event_id,owner_id,source_task_id,hook_id,original_key,item_id,revision_id,selection_generation,input,pins,state,created_at)
        VALUES (?,?,?,?,?,?,?,0,?,?,'PENDING',?)`).run(event, actor, task, hook, key, item, revisionId,
        json({ taskId: task, occurredAt: c.occurredAt }), json(binding.manifest), c.occurredAt);
      db.prepare(`INSERT INTO shared_completion_events(id,original_key,source_id,actor_id,project_id,occurred_at,personal_event_id,state)
        VALUES (?,?,?,?,?,?,?,'PENDING')`).run(event, key, task, actor, project, c.occurredAt, event);
      if (update || Object.hasOwn(c, 'sourceDueAt')) db.prepare('UPDATE tasks SET notes=?,due_at=? WHERE id=?')
        .run(update ? 'Keep these notes.\0Exact.' : '', Object.hasOwn(c, 'sourceDueAt') ? c.sourceDueAt : c.occurredAt, task);
      // Seed native inputs before arming the example's edit protection.
      if (createdUpdate) db.prepare('INSERT INTO shared_created_updates(event_id,source_id) VALUES (?,?)').run(event, task);
      else if (update) db.prepare('INSERT INTO shared_priority_fences(source_id) VALUES (?)').run(task);
      const sourceState = () => db.prepare('SELECT *,hex(title) titleBytes,hex(notes) notesBytes FROM tasks WHERE id=?').get(task);
      const sourceBefore = update && sourceState();
      await completionExecutor({ db, guard, clock: () => Math.floor(performance.now()), beforeWrite: check,
        observedMatch: value => openMatches.push(value), observedTask: value => taskReads.push(value) }, binding, exampleBundle).run(event);
      check();
      const result = db.prepare('SELECT * FROM shared_completion_events WHERE id=?').get(event);
      const receiptText = createdUpdate ? db.prepare('SELECT receipt FROM shared_created_updates WHERE event_id=?').get(event).receipt : result.receipt;
      const outcome = JSON.parse(result.outcome), receipt = receiptText && JSON.parse(receiptText);
      const placedProject = owned ? receipt?.projectId ?? project : project;
      const placement = result.created_task_id && db.prepare(`SELECT parent_task_id, assignee_id, creator_id, CAST(notes AS BLOB) notes
        FROM tasks WHERE id=? AND owner_id=? AND project_id=?`).get(result.created_task_id, actor, placedProject);
      const created = placement && readCustomizationTask(db, actor, result.created_task_id, placedProject);
      let observed = created ? { title: created.title, dueAt: created.dueAt, linked: placement.parent_task_id === task,
        assigneeId: placement.assignee_id, ...(full && { project: owned ? created.projectId : SAME_PROJECT, notes: Buffer.from(placement.notes).toString('utf8'),
          tags: created.tags, priority: created.priority }) } : null;
      const write = binding.write;
      const taskCount = full && db.prepare('SELECT count(*) n FROM tasks').get().n;
      let confirmed = created && receipt?.eventId === event && receipt.originalKey === key && receipt.projectId === placedProject
        && (!owned || receipt.version === (exact ? '9' : '4') && JSON.parse(receipt.payload).projectId === created.projectId)
        && receipt.capability === 'tasks.create' && receipt.parentTaskId === placement.parent_task_id
        && receipt.result?.kind === 'SUCCESS' && receipt.result.effect === 'CONFIRMED' && receipt.result.value?.id === created.id
        && outcome.effects.length === 1 && outcome.effects[0].step === write?.id
        && outcome.effects[0].capability === 'tasks.create' && outcome.effects[0].state === 'CONFIRMED'
        && (!full || taskCount === startingCount + 1 && placement.creator_id === (team ? actor : null)
          && (placement.parent_task_id === null || team && placement.parent_task_id === task));
      let updateBranch;
      const sourceAfter = update && sourceState();
      if (update && receipt && verifiedUpdate(result, receipt, binding.host.pins.definitionId) && taskCount === startingCount && sourceAfter
        && outcome.effects.length === 1 && outcome.effects[0].step === write.id
        && outcome.effects[0].capability === 'tasks.update' && outcome.effects[0].state === 'CONFIRMED') {
        const { before, after } = receipt.observation.updated;
        const previous = { priority: sourceBefore.priority, tags: JSON.parse(sourceBefore.tags), dueAt: sourceBefore.due_at };
        const changed = json(before) !== json(after);
        confirmed = json(previous) === json(before) && json(sourceAfter) === json({ ...sourceBefore,
          tags: json(after.tags), priority: after.priority, due_at: after.dueAt, ...(changed && { updated_at: sourceAfter.updated_at }) });
        if (confirmed) {
          observed = combinedUpdate ? { sourceAfter: { tags: JSON.parse(sourceAfter.tags), priority: sourceAfter.priority, dueAt: sourceAfter.due_at } }
            : updateTags ? { sourceTags: JSON.parse(sourceAfter.tags) }
            : updateDue ? { sourceDueAt: sourceAfter.due_at } : { sourcePriority: sourceAfter.priority };
          updateBranch = changed ? 'UPDATED' : 'UNCHANGED';
        }
      }
      const noEffect = !receipt && !result.created_task_id && outcome.effects.length === 0
        && (!full || taskCount === startingCount && outcome.classification === 'COMPLETED' && outcome.result?.status === 'NO_OP')
        && (!update || json(sourceBefore) === json(sourceAfter));
      const skipped = write && outcome.trace.some(entry => entry.event === 'STEP_SKIPPED' && entry.step === write.id);
      checks.push({ id: c.id, classification: outcome.classification, status: outcome.result?.status ?? null,
        effect: confirmed ? 'CONFIRMED' : noEffect ? 'NONE' : 'UNVERIFIED',
        branch: confirmed ? updateBranch ?? 'CREATED' : noEffect && !write ? 'NO_WRITE' : noEffect && skipped ? 'SKIPPED' : 'UNVERIFIED', observed,
        ...(lookup && { openMatches }), ...(exact && { taskReads }) });
    } finally { await guard?.close(); db.close(); }
  }
  return { harness: binding.harness, revisionId, executableIdentity: binding.executableIdentity,
    caseDigest: binding.manifest.caseDigest, checks, passed: completionChecksPass(binding, checks) };
}
