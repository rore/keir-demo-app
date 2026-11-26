import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { AppError, notFound, transaction, taskService } from './data.mjs';
import { projectAccess, taskAccess, verifiedChild } from './team-native.mjs';
import { digest, json } from './extension-catalog.mjs';
import { SHARED_MANIFEST } from './shared-completion-contract.mjs';
import { isTaskBundle } from './shared-task-bundle.mjs';

export let teamModelBytes, teamModel;
try {
  teamModelBytes = readFileSync(new URL('../keir/team-v1.json', import.meta.url));
  teamModel = JSON.parse(teamModelBytes);
} catch { /* Missing Team dependencies must not prevent Personal native task startup. */ }
const unavailable = () => new AppError(503, 'The pinned Team check is unavailable. Your task is kept.');
const stale = () => new AppError(409, 'The task or its authority changed. Check it again.');
const reject = write => ({ kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', ...(write ? { effect: 'NONE' } : {}) });
const member = (db, project, actor) => db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(project, actor);

export function validateTeamBundle(hooks) {
  if (!teamModel?.capabilities || !teamModelBytes) throw unavailable();
  if (!hooks || Object.keys(hooks).sort().join() !== 'TaskBeforeComplete,TaskCreated') throw unavailable();
  const manifest = { modelDigest: digest(teamModelBytes), grants: Object.keys(teamModel.capabilities) }, artifacts = {};
  // Preparation checks the artifact against the real native model, not merely its JSON shape.
  const adapters = Object.fromEntries(Object.entries(teamModel.capabilities).map(([id, value]) => [id,
    { version: value.version, mode: 'real', keyType: teamModel.hostKey.type, invoke: async () => reject(value.effect === 'WRITE') }]));
  const bound = bindModel(teamModelBytes, adapters);
  if (bound.diagnostic || !bound.boundModel) throw unavailable();
  for (const hook of ['TaskCreated', 'TaskBeforeComplete']) {
    if (hooks[hook] === null) { manifest[hook] = null; continue; }
    if (!(hooks[hook] instanceof Uint8Array) || hooks[hook].length > 1048576) throw unavailable();
    const bytes = Buffer.from(hooks[hook]), artifact = JSON.parse(bytes);
    if (artifact.entrypoint !== hook || !prepareProgram(bytes, bound.boundModel).prepared) throw unavailable();
    manifest[hook] = digest(bytes);
    artifacts[manifest[hook]] = bytes.toString('utf8');
  }
  if (Buffer.byteLength(json(artifacts)) > 2097152) throw unavailable();
  return { manifest, artifacts };
}

// Trusted manual installation only. No request accepts artifacts, principals, pins or effect keys.
export function installTeamRevision(db, actor, projectId, revisionId, hooks) {
  return transaction(db, () => {
    if (projectAccess(db, actor, projectId, true).mode !== 'TEAM') throw notFound();
    if (typeof revisionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(revisionId)) throw unavailable();
    const { manifest, artifacts } = validateTeamBundle(hooks);
    db.prepare('INSERT INTO team_revisions(project_id,revision_id,manifest,artifacts) VALUES (?,?,?,?)')
      .run(projectId, revisionId, json(manifest), json(artifacts));
  });
}

export function createTeamRuntime({ db, clock = () => Math.floor(performance.now()),
  beforeCompleteCommit, beforeEffectCommit, effectReply, sharedCompletion } = {}) {
  const keys = new WeakMap(), running = new Set();
  let closing = false, draining, requested = false;
  const admission = id => db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(id);
  const savedEvent = id => db.prepare('SELECT * FROM team_admissions WHERE event_id=?').get(id);
  const bundleAdmission = taskId => db.prepare(`SELECT a.event_id,a.project_id,a.source_task_id,a.initiator_id,
    a.operation_id,a.original_key,a.revision_id,a.policy_state,a.manifest,a.created_at,p.activation_id
    FROM team_admissions a JOIN shared_completion_roots p ON p.root_id=a.event_id WHERE a.source_task_id=?`).get(taskId);
  const taskIdentity = ({ id, owner_id, project_id, creator_id, parent_task_id, origin_event_id, created_at }) =>
    [id, owner_id, project_id, creator_id, parent_task_id, origin_event_id, created_at];
  function revision(row) {
    if (row?.policy_state !== 'PINNED' || !row.revision_id || !row.manifest) throw unavailable();
    const saved = db.prepare('SELECT * FROM team_revisions WHERE project_id=? AND revision_id=?')
      .get(row.project_id, row.revision_id);
    if (!saved || saved.revoked_at !== null || saved.manifest !== row.manifest) throw unavailable();
    const manifest = JSON.parse(saved.manifest);
    if (Object.hasOwn(manifest, 'format')) {
      if (isTaskBundle(manifest.format) && sharedCompletion) {
        if ((manifest.hooks.TaskCreated === null) !== (row.state === 'NO_HOOK')) throw unavailable();
        return { manifest: manifest.hooks, exact: sharedCompletion.teamBinding(row) };
      }
      if (manifest.format !== SHARED_MANIFEST || !sharedCompletion || row.state !== 'NO_HOOK') throw unavailable();
      sharedCompletion.teamBinding(row);
      return { manifest: manifest.hooks };
    }
    if (!teamModel?.capabilities || !teamModelBytes || manifest.modelDigest !== digest(teamModelBytes) || !Array.isArray(manifest.grants)
        || manifest.grants.some(id => !Object.hasOwn(teamModel.capabilities, id))
        || !Object.hasOwn(manifest, 'TaskCreated') || !Object.hasOwn(manifest, 'TaskBeforeComplete')) throw unavailable();
    return { manifest, artifacts: JSON.parse(saved.artifacts) };
  }
  function within(ctx) {
    const now = ctx.deadline.clock.nowMs();
    if (closing || ctx.stopped || ctx.signal?.aborted || !Number.isSafeInteger(now) || now < ctx.lastNow
        || now < 0 || !Number.isSafeInteger(ctx.deadline.expiresAtMs) || now >= ctx.deadline.expiresAtMs) throw stale();
    ctx.lastNow = now;
  }
  function authority(ctx) {
    within(ctx);
    if (ctx.authorize && ctx.authorize() !== ctx.actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
    const { row: task, project } = taskAccess(db, ctx.actor, ctx.row.source_task_id, ctx.hook === 'TaskBeforeComplete');
    if (project.mode !== 'TEAM' || project.id !== ctx.row.project_id) throw notFound();
    const fresh = savedEvent(ctx.row.event_id);
    if (!fresh || fresh.manifest !== ctx.row.manifest || fresh.revision_id !== ctx.row.revision_id
        || fresh.original_key !== ctx.row.original_key || fresh.source_task_id !== ctx.row.source_task_id
        || fresh.initiator_id !== ctx.row.initiator_id || fresh.project_id !== ctx.row.project_id) throw unavailable();
    if (ctx.hook === 'TaskCreated' && (fresh.state !== 'STARTED' || fresh.claim !== ctx.claim || ctx.actor !== fresh.initiator_id))
      throw unavailable();
    const selected = revision(fresh);
    if (selected.manifest[ctx.hook] !== ctx.artifactDigest) throw unavailable();
    const bytes = selected.artifacts[ctx.artifactDigest];
    if (typeof bytes !== 'string' || digest(bytes) !== ctx.artifactDigest) throw unavailable();
    return { task, project, manifest: selected.manifest };
  }
  function projection(ctx, capability, args) {
    const { row: task, project } = taskAccess(db, ctx.actor, capability === 'tasks.get' ? args.taskId : args.parentTaskId);
    if (project.id !== ctx.row.project_id) throw notFound();
    if (capability === 'tasks.get') return { id: task.id, projectId: task.project_id, priority: task.priority,
      status: task.status === 'open' ? 'OPEN' : 'COMPLETED',
      ...(task.parent_task_id === null ? {} : { parentTaskId: task.parent_task_id }),
      ...(task.assignee_id === null ? {} : { assigneeId: task.assignee_id }),
      ...(task.due_at === null ? {} : { dueAt: task.due_at }) };
    const children = db.prepare(`SELECT t.* FROM tasks t JOIN team_admissions a
      ON a.event_id=t.origin_event_id AND a.child_id=t.id AND a.source_task_id=t.parent_task_id AND a.project_id=t.project_id
      WHERE t.project_id=? AND t.parent_task_id=? AND (? IS NULL OR t.origin_event_id=?) LIMIT 2`)
      .all(project.id, task.id, args.originEventId ?? null, args.originEventId ?? null);
    const verified = children.filter(child => verifiedChild(db, child));
    return { exists: verified.length > 0, anyIncomplete: verified.some(child => child.status !== 'completed') };
  }
  function recheckReads(ctx) {
    for (const read of ctx.reads) if (json(projection(ctx, read.capability, read.args)) !== read.value) throw stale();
  }
  function writeChild(ctx, args) {
    return transaction(db, () => {
      const { task, project } = authority(ctx), saved = savedEvent(ctx.row.event_id), payload = json(args);
      if (saved.receipt !== null) {
        const receipt = JSON.parse(saved.receipt);
        return receipt.payload === payload && receipt.capability === 'tasks.create' ? receipt.result : reject(true);
      }
      recheckReads(ctx);
      if (Object.keys(args).some(key => !['projectId', 'title', 'parentTaskId', 'assigneeId'].includes(key))
          || args.projectId !== project.id || args.parentTaskId !== task.id || task.parent_task_id !== null
          || typeof args.assigneeId !== 'string' || !member(db, project.id, args.assigneeId)
          || typeof args.title !== 'string' || !args.title.isWellFormed() || !args.title.trim()
          || args.title.length > 120 || /\p{Cc}/u.test(args.title)) return reject(true);
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,creator_id,
        assignee_id,parent_task_id,origin_event_id) VALUES (?,?,?,?,'','open',?,?,?,?,?,?)`)
        .run(id, project.owner_id, project.id, args.title.trim(), now, now, ctx.row.initiator_id, args.assigneeId, task.id, ctx.row.event_id);
      const result = { kind: 'SUCCESS', value: { id }, effect: 'CONFIRMED' };
      const receipt = { capability: 'tasks.create', originalKey: saved.original_key, eventId: saved.event_id,
        payload, result, effect: 'CONFIRMED' };
      db.prepare('UPDATE team_admissions SET receipt=?,child_id=? WHERE event_id=? AND state=? AND claim=?')
        .run(json(receipt), id, saved.event_id, 'STARTED', ctx.claim);
      authority(ctx);
      if (!member(db, project.id, args.assigneeId) || !verifiedChild(db, db.prepare('SELECT * FROM tasks WHERE id=?').get(id))) throw stale();
      return result;
    });
  }
  const adapters = Object.fromEntries(Object.entries(teamModel?.capabilities ?? {}).map(([capability, descriptor]) => [capability, {
    version: descriptor.version, mode: 'real', keyType: teamModel.hostKey.type,
    async invoke(args, protectedArgs, remaining, invocation) {
      const write = descriptor.effect === 'WRITE', ctx = keys.get(invocation?.requestKey);
      try {
        if (!ctx || remaining <= 0 || protectedArgs.actorId !== ctx.actor
            || invocation.event.id !== ctx.eventId || invocation.event.source !== ctx.row.source_task_id
            || invocation.deadline.expiresAtMs !== ctx.deadline.expiresAtMs) return reject(write);
        const { manifest } = authority(ctx);
        if (!manifest.grants.includes(capability) || ++ctx.calls > 4 || write && ctx.hook !== 'TaskCreated') return reject(write);
        if (!write) {
          const value = projection(ctx, capability, args);
          authority(ctx);
          ctx.reads.push({ capability, args: { ...args }, value: json(value) });
          return { kind: 'SUCCESS', value };
        }
        await beforeEffectCommit?.({ eventId: ctx.row.event_id, args });
        const result = writeChild(ctx, args);
        return effectReply ? await effectReply(result) : result;
      } catch (error) {
        if (write) return { kind: 'UNKNOWN_COMMIT', effect: 'UNKNOWN' };
        return error.status === 404 ? { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' } : reject(false);
      }
    },
  }]));
  let bound = {};
  try { if (teamModelBytes) bound = bindModel(teamModelBytes, adapters); }
  catch { /* Covered Team work fails closed in run; Personal tasks remain usable. */ }
  async function run(row, actor, hook, context = {}) {
    const selected = revision(row), artifactDigest = selected.manifest[hook];
    const text = selected.artifacts[artifactDigest];
    if (!bound.boundModel || bound.diagnostic || typeof text !== 'string' || digest(text) !== artifactDigest) throw unavailable();
    const prepared = prepareProgram(Buffer.from(text), bound.boundModel);
    if (!prepared.prepared || prepared.diagnostic || JSON.parse(text).entrypoint !== hook) throw unavailable();
    const deadline = context.deadline ?? { clock: { nowMs: clock }, expiresAtMs: clock() + 1000 };
    const ctx = { row, actor, hook, artifactDigest, claim: row.claim, deadline, lastNow: -1,
      eventId: hook === 'TaskCreated' ? row.event_id : randomUUID(), reads: [], calls: 0,
      signal: context.signal, authorize: context.authorize, stopped: false };
    const key = Object.freeze({ type: teamModel.hostKey.type, value: row.original_key });
    keys.set(key, ctx);
    let timer, abort, completed = false;
    try {
      authority(ctx);
      const outcome = await Promise.race([
        invokeProgram(prepared.prepared, hook === 'TaskCreated'
          ? { taskId: row.source_task_id, occurredAt: row.created_at }
          : { taskId: row.source_task_id, creationEventId: row.event_id },
        { bindings: { actorId: actor }, requestKey: key, event: { id: ctx.eventId, source: row.source_task_id }, deadline }),
        new Promise((_, rejectPromise) => {
          abort = () => rejectPromise(stale());
          timer = setTimeout(abort, Math.max(0, deadline.expiresAtMs - deadline.clock.nowMs()));
          context.signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
      if (hook === 'TaskBeforeComplete') authority(ctx);
      completed = true;
      return { outcome, ctx };
    } finally {
      keys.delete(key);
      if (!completed || hook === 'TaskCreated') ctx.stopped = true;
      clearTimeout(timer);
      if (abort) context.signal?.removeEventListener('abort', abort);
    }
  }
  async function attempt(row) {
    if (isTaskBundle(JSON.parse(row.manifest ?? 'null')?.format)) {
      try { await sharedCompletion?.run(row.event_id); } catch { /* Unavailable exact attempts never bypass the shared binding. */ }
      return;
    }
    let claimed;
    try {
      claimed = transaction(db, () => {
        const fresh = savedEvent(row.event_id);
        if (closing || fresh?.state !== 'PENDING') return null;
        projectAccess(db, fresh.initiator_id, fresh.project_id);
        revision(fresh);
        db.prepare("UPDATE team_admissions SET state='STARTED',claim=? WHERE event_id=? AND state='PENDING'").run(randomUUID(), row.event_id);
        return savedEvent(row.event_id);
      });
      if (!claimed) return;
      const { outcome } = await run(claimed, claimed.initiator_id, 'TaskCreated');
      db.prepare('UPDATE team_admissions SET outcome=? WHERE event_id=? AND outcome IS NULL').run(json(outcome), row.event_id);
    } catch { /* Native receipt is authoritative even if the runtime reply is lost. */ }
    finally {
      if (claimed) db.prepare("UPDATE team_admissions SET state='CLOSED' WHERE event_id=? AND state='STARTED' AND claim=?").run(row.event_id, claimed.claim);
    }
  }
  function status(actor, taskId, hook = 'TaskCreated') {
    const { project } = taskAccess(db, actor, taskId);
    if (project.mode !== 'TEAM') throw notFound();
    if (!['TaskCreated', 'TaskCompleted'].includes(hook)) throw new AppError(400, 'Choose a task trigger.');
    if (hook === 'TaskCompleted') return { state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null };
    const row = admission(taskId);
    if (!row) {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!verifiedChild(db, task) && !sharedCompletion?.verifiedCreatedTask(task)) throw unavailable();
      return { state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null };
    }
    const receipt = row.receipt && JSON.parse(row.receipt);
    return { state: row.state === 'NO_HOOK' ? 'NO_BINDING' : row.state === 'CLOSED' ? 'FINISHED' : row.state,
      team: true, revisionId: row.revision_id, originalKey: row.original_key,
      outcome: row.outcome && JSON.parse(row.outcome), receipt: receipt?.result ?? null,
      reconciliation: row.observation && JSON.parse(row.observation),
      message: row.state === 'PENDING' ? 'This task is kept. Its pinned rule has not run.'
        : !receipt && row.state === 'CLOSED' ? 'No linked write is confirmed. Completion stays blocked if the rule requires it.' : undefined };
  }
  async function complete(actor, taskId, context) {
    context = { ...context, deadline: context.deadline ?? { clock: { nowMs: clock }, expiresAtMs: clock() + 1000 } };
    const lease = { deadline: context.deadline, lastNow: -1, signal: context.signal };
    within(lease);
    const initial = taskAccess(db, actor, taskId, true);
    if (initial.project.mode !== 'TEAM') throw notFound();
    if (initial.row.status === 'completed') return transaction(db, () => {
      within(lease);
      if (context.authorize && context.authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
      taskAccess(db, actor, taskId, true);
      return taskService(db).getTask(actor, taskId);
    });
    const row = admission(taskId);
    const bundled = isTaskBundle(JSON.parse(row?.manifest ?? 'null')?.format);
    const pin = bundled && bundleAdmission(taskId);
    let evaluated;
    const gateAuthority = (status = 'open') => {
      within(lease);
      if (context.authorize && context.authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
      const { row: task, project } = taskAccess(db, actor, taskId, true);
      const fresh = admission(taskId);
      if (!pin || !fresh || project.id !== row.project_id || project.mode !== 'TEAM' || task.status !== status
          || task.created_at !== row.created_at || task.creator_id !== row.initiator_id
          || json(bundleAdmission(taskId)) !== json(pin) || json(taskIdentity(task)) !== json(taskIdentity(initial.row))) throw stale();
      revision(fresh);
      return { task, project };
    };
    const sharedCreated = sharedCompletion?.verifiedCreatedTask(initial.row) === true;
    if (!sharedCreated && !initial.row.parent_task_id) {
      if (!row) throw unavailable();
      if (row.policy_state !== 'NO_POLICY') {
        const selected = revision(row);
        if (selected.manifest.TaskBeforeComplete !== null) evaluated = bundled
          ? await sharedCompletion.beforeTeamComplete(actor, row, selected.exact.bindings.TaskBeforeComplete,
            { authority: gateAuthority, deadline: lease.deadline })
          : await run(row, actor, 'TaskBeforeComplete', context);
      }
    } else if (!sharedCreated && !verifiedChild(db, initial.row)) throw unavailable();
    await beforeCompleteCommit?.({ actor, taskId });
    return transaction(db, () => {
      within(lease);
      if (context.authorize && context.authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
      if (context.signal?.aborted) throw stale();
      const current = taskAccess(db, actor, taskId, true);
      if (sharedCreated) {
        if (!sharedCompletion.verifiedCreatedTask(current.row)) throw unavailable();
      } else if (current.row.parent_task_id) {
        if (!verifiedChild(db, current.row)) throw unavailable();
      } else {
        const fresh = admission(taskId);
        if (!fresh || (bundled ? !pin || json(bundleAdmission(taskId)) !== json(pin)
          || json(taskIdentity(current.row)) !== json(taskIdentity(initial.row)) : json(fresh) !== json(row))) throw stale();
        if (fresh.policy_state === 'NO_POLICY') {
          if (fresh.revision_id !== null || fresh.manifest !== null) throw unavailable();
        } else {
          const selected = revision(fresh);
          if (selected.manifest.TaskBeforeComplete !== null) {
            if (!evaluated) throw unavailable();
            if (bundled) {
              evaluated.recheck();
              if (evaluated.result.decision !== 'ALLOW') throw new AppError(422, evaluated.result.message);
            } else {
              const { outcome, ctx } = evaluated;
              authority(ctx);
              recheckReads(ctx);
              if (outcome.classification !== 'COMPLETED' || !Array.isArray(outcome.effects) || outcome.effects.length
                  || !outcome.result || !['ALLOW', 'DENY'].includes(outcome.result.decision)
                  || typeof outcome.result.message !== 'string') throw unavailable();
              if (outcome.result.decision !== 'ALLOW') throw new AppError(422, outcome.result.message.slice(0, 256) || 'This task is not ready to complete.');
            }
          }
        }
      }
      const now = new Date().toISOString();
      const changed = db.prepare("UPDATE tasks SET status='completed',completed_at=?,updated_at=? WHERE id=? AND status='open'").run(now, now, taskId).changes;
      if (evaluated?.ctx) authority(evaluated.ctx);
      if (row?.policy_state === 'PINNED') revision(admission(taskId));
      within(lease);
      taskAccess(db, actor, taskId, true);
      if (context.authorize && context.authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
      if (changed && !sharedCreated) sharedCompletion?.capture(actor, taskId, now);
      if (evaluated?.recheck) evaluated.recheck('completed');
      return taskService(db).getTask(actor, taskId);
    });
  }
  const track = promise => {
    running.add(promise);
    promise.then(() => running.delete(promise), () => running.delete(promise));
    return promise;
  };
  async function drain() {
    do {
      requested = false;
      let after = 0;
      while (!closing) {
        const rows = db.prepare("SELECT rowid AS sequence,* FROM team_admissions WHERE state='PENDING' AND rowid>? ORDER BY rowid LIMIT 20").all(after);
        if (!rows.length) break;
        for (const row of rows) {
          after = row.sequence;
          if (closing) break;
          await attempt(row);
        }
      }
    } while (requested && !closing);
  }
  return Object.freeze({
    complete(actor, taskId, context = {}) { return track(complete(actor, taskId, context)); },
    wake() {
      if (closing) return Promise.resolve();
      requested = true;
      if (!draining) draining = track(Promise.resolve().then(drain)).finally(() => {
        draining = null;
        if (requested && !closing) void this.wake();
      });
      return draining ?? Promise.resolve();
    },
    status,
    reconcile(actor, taskId, hook = 'TaskCreated') {
      return transaction(db, () => {
        status(actor, taskId, hook);
        if (hook !== 'TaskCreated') throw notFound();
        const row = admission(taskId);
        if (!row) throw notFound();
        let effect = 'UNRESOLVED';
        if (row.receipt) {
          const receipt = JSON.parse(row.receipt), child = db.prepare('SELECT * FROM tasks WHERE id=?').get(row.child_id);
          if (receipt.originalKey === row.original_key && receipt.eventId === row.event_id) {
            if (receipt.effect === 'CONFIRMED' && child && verifiedChild(db, child)) effect = 'CONFIRMED';
            if (receipt.effect === 'NONE' && row.state === 'CLOSED') effect = 'NONE';
          }
        } else if (row.state === 'CLOSED') effect = 'NONE'; // Closed claims are fenced at every native commit.
        const observation = { observedAt: new Date().toISOString(), originalKey: row.original_key, effect,
          receipt: effect === 'CONFIRMED' ? JSON.parse(row.receipt).result : null };
        db.prepare('UPDATE team_admissions SET observation=? WHERE event_id=?').run(json(observation), row.event_id);
        return status(actor, taskId, hook);
      });
    },
    async close() { closing = true; await Promise.allSettled(running); },
  });
}
