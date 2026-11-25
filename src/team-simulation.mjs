import { randomUUID } from 'node:crypto';
import { openData, taskService, AppError } from './data.mjs';
import { createTeamRuntime, validateTeamBundle } from './team-runtime.mjs';
import { verifiedChild } from './team-native.mjs';
import { digest, json } from './extension-catalog.mjs';

export const TEAM_HARNESS = 'daymark-team-native-simulation/1';
const invalid = () => new AppError(400, 'Use the bounded Team example format.');
const object = (value, keys, required = keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw invalid();
};
const word = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const title = value => typeof value === 'string' && value.isWellFormed() && value.trim() && value.length <= 120 && !/\p{Cc}/u.test(value);
const required = { create: ['status'], dispatch: ['children', 'outcome', 'receipt'], complete: ['decision', 'status'], reconcile: ['effect', 'children'] };
const values = { status: ['open', 'completed'], children: [0, 1], outcome: ['COMPLETED', 'FAILED', 'UNCERTAIN', 'UNKNOWN', 'NONE'],
  receipt: ['CONFIRMED', 'NONE'], decision: ['ALLOW', 'DENY', 'BLOCKED'], effect: ['CONFIRMED', 'NONE', 'UNRESOLVED'] };

export function normalizeTeamCases(input, { authored = false } = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > (authored ? 16 : 8)) throw invalid();
  const ids = new Set();
  for (const c of input) {
    object(c, ['id', 'name', 'actors', 'initialTasks', 'fault', 'actions']);
    if (!word(c.id) || ids.has(c.id) || !title(c.name) || !['NONE', 'BEFORE_WRITE', 'LOST_REPLY'].includes(c.fault)
        || !Array.isArray(c.actors) || c.actors.length < 2 || c.actors.length > 4
        || !Array.isArray(c.initialTasks) || c.initialTasks.length > 16
        || !Array.isArray(c.actions) || !c.actions.length || c.actions.length > (authored ? 12 : 8)) throw invalid();
    ids.add(c.id);
    const actors = new Set(), users = new Set(), refs = new Set();
    for (const a of c.actors) {
      object(a, authored ? ['id', 'userId', 'role'] : ['id', 'role']);
      if (!word(a.id) || actors.has(a.id) || !['ADMIN', 'MEMBER'].includes(a.role)) throw invalid();
      if (authored && (typeof a.userId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(a.userId) || users.has(a.userId))) throw invalid();
      actors.add(a.id);
      users.add(a.userId);
    }
    if ((!authored && !actors.has('reviewer')) || !c.actors.some(a => a.role === 'ADMIN')) throw invalid();
    for (const task of c.initialTasks) {
      object(task, authored ? ['ref', 'actor', 'title', 'priority'] : ['ref', 'actor', 'title'], ['ref', 'actor', 'title']);
      if (!word(task.ref) || refs.has(task.ref) || !actors.has(task.actor) || !title(task.title)) throw invalid();
      if (Object.hasOwn(task, 'priority') && !['low', 'normal', 'high'].includes(task.priority)) throw invalid();
      refs.add(task.ref);
    }
    for (const action of c.actions) {
      const keys = action?.op === 'create' ? ['op', 'actor', 'ref', 'title', 'expect']
        : action?.op === 'dispatch' ? ['op', 'ref', 'expect'] : ['op', 'actor', 'ref', 'expect'];
      object(action, authored ? [...keys, ...(action?.op === 'create' ? ['priority'] : []), 'covers'] : keys, keys);
      if (!Object.hasOwn(required, action.op)) throw invalid();
      if (action.op !== 'dispatch' && !actors.has(action.actor)) throw invalid();
      if (action.op === 'create') {
        if (!word(action.ref) || refs.has(action.ref) || !title(action.title)) throw invalid();
        refs.add(action.ref);
        if (Object.hasOwn(action, 'priority') && !['low', 'normal', 'high'].includes(action.priority)) throw invalid();
      } else if (typeof action.ref !== 'string' || !refs.has(action.ref.replace(authored ? /\.(?:child|review)$/ : /\.review$/, ''))) throw invalid();
      if (authored && Object.hasOwn(action, 'covers')) {
        object(action.covers, ['claimId', 'outcomeId']);
        if (!word(action.covers.claimId) || !word(action.covers.outcomeId)
            || !['dispatch', 'complete'].includes(action.op) || /\.(?:child|review)$/.test(action.ref)) throw invalid();
      }
      const extra = ['childTitle', 'childAssigneeId', 'reportStatus', 'message'];
      object(action.expect, [...Object.keys(values), ...(authored ? extra : [])], required[action.op]);
      for (const [key, value] of Object.entries(action.expect))
        if (Object.hasOwn(values, key) ? !values[key].includes(value)
          : typeof value !== 'string' || !value.isWellFormed() || value.length > (key === 'childTitle' ? 120 : 256) || /\p{Cc}/u.test(value)) throw invalid();
    }
  }
  const normalized = json(input);
  if (Buffer.byteLength(normalized) > 32768) throw invalid();
  return JSON.parse(normalized); // Snapshot exact normalized givens and independent expectations before work.
}

// No operator DB handle is accepted. All identities, tasks and faults below are synthetic.
export async function simulateTeam({ projectId, revisionId, manifest, artifacts, parameters, cases }, lease) {
  const authored = parameters.kind === 'authored-team/1';
  const results = [];
  for (const c of cases) {
    lease.check();
    const db = openData(':memory:', { seed: false });
    let runtime, closing;
    const stop = () => { if (runtime) closing ??= runtime.close(); };
    lease.signal.addEventListener('abort', stop, { once: true });
    try {
      const hooks = Object.fromEntries(['TaskCreated', 'TaskBeforeComplete'].map(hook => {
        if (authored && manifest[hook] === null) return [hook, null];
        const text = artifacts[manifest[hook]];
        if (typeof text !== 'string' || digest(text) !== manifest[hook]) throw new AppError(503, 'The exact Team artifact is unavailable.');
        return [hook, Buffer.from(text)];
      }));
      const validated = validateTeamBundle(hooks);
      for (const hook of Object.keys(hooks)) if (validated.manifest[hook] !== manifest[hook]) throw invalid();
      const actors = Object.fromEntries(c.actors.map(a => [a.id, authored ? a.userId : a.id === 'reviewer' ? parameters.reviewerId : 'simulation:' + a.id]));
      const admin = actors[c.actors.find(a => a.role === 'ADMIN').id], now = '2026-01-02T03:04:05.678Z';
      for (const a of c.actors) db.prepare('INSERT INTO users VALUES (?,?)').run(actors[a.id], 'Synthetic ' + a.id);
      db.prepare("INSERT INTO projects(id,owner_id,name,created_at,updated_at,mode) VALUES (?,?,'Synthetic Team',?,?,'TEAM')")
        .run(projectId, admin, now, now);
      for (const a of c.actors) db.prepare('INSERT INTO project_members VALUES (?,?,?)').run(projectId, actors[a.id], a.role);
      db.prepare('INSERT INTO team_selections(project_id) VALUES (?)').run(projectId);
      db.prepare('INSERT INTO team_drafts(project_id) VALUES (?)').run(projectId);
      const writeCalls = new Map();
      runtime = createTeamRuntime({ db, clock: () => { lease.check(); return lease.now(); },
        beforeEffectCommit: ({ eventId }) => {
          lease.check(); writeCalls.set(eventId, (writeCalls.get(eventId) ?? 0) + 1);
          if (c.fault === 'BEFORE_WRITE') throw new Error('Synthetic before-write loss');
        },
        effectReply: result => { if (c.fault === 'LOST_REPLY') throw new Error('Synthetic committed-reply loss'); return result; } });
      const tasks = taskService(db, { team: runtime }), refs = new Map(), events = [];
      const context = () => ({ operationId: randomUUID(), signal: lease.signal,
        deadline: { clock: { nowMs: lease.now }, expiresAtMs: lease.now() + Math.min(1000, lease.remaining()) } });
      for (const t of c.initialTasks) refs.set(t.ref, (await tasks.createTask(actors[t.actor], { projectId, title: t.title,
        ...(authored && t.priority ? { priority: t.priority } : {}) }, context())).id);
      db.prepare('INSERT INTO team_revisions(project_id,revision_id,manifest,artifacts) VALUES (?,?,?,?)')
        .run(projectId, revisionId, json(manifest), json(artifacts));
      db.prepare('UPDATE team_selections SET revision_id=? WHERE project_id=?').run(revisionId, projectId);
      const resolveRef = ref => {
        const root = refs.get(ref.replace(authored ? /\.(?:child|review)$/ : /\.review$/, ''));
        if (!ref.endsWith('.review') && !(authored && ref.endsWith('.child'))) return root;
        const row = db.prepare('SELECT t.* FROM tasks t JOIN team_admissions a ON a.child_id=t.id WHERE a.source_task_id=?').get(root);
        return row && verifiedChild(db, row) ? row.id : null;
      };
      const facts = taskId => {
        const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
        const children = db.prepare('SELECT * FROM tasks WHERE parent_task_id=?').all(taskId).filter(t => verifiedChild(db, t));
        return task ? { priority: task.priority, status: task.status, children: children.length,
          childStatus: !children.length ? 'absent' : children.some(t => t.status !== 'completed') ? 'open' : 'completed' } : null;
      };
      for (const [index, action] of c.actions.entries()) {
        lease.check();
        let taskId = resolveRef(action.ref), decision, message;
        const before = authored && taskId ? facts(taskId) : null;
        const admissionBefore = authored && taskId ? db.prepare('SELECT state FROM team_admissions WHERE source_task_id=?').get(taskId)?.state ?? null : null;
        if (action.op === 'create') {
          const task = await tasks.createTask(actors[action.actor], { projectId, title: action.title,
            ...(authored && action.priority ? { priority: action.priority } : {}) }, context());
          refs.set(action.ref, task.id); taskId = task.id;
        } else if (action.op === 'dispatch') {
          // The existing native reaction has a one-second cap. Do not start it with less overall budget.
          if (lease.remaining() < 1000) throw new AppError(409, 'The simulation deadline expired.');
          await runtime.wake();
        } else if (action.op === 'complete') {
          try {
            if (!taskId) throw new AppError(503, 'No verified linked task exists.');
            await tasks.completeTask(actors[action.actor], taskId, context()); decision = 'ALLOW';
          } catch (error) {
            lease.check();
            if (!(error instanceof AppError)) throw error;
            decision = error.status === 422 ? 'DENY' : 'BLOCKED';
            message = error.message;
          }
        } else {
          if (!taskId) throw invalid();
          runtime.reconcile(actors[action.actor], taskId);
        }
        lease.check();
        const task = taskId && db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
        const row = taskId && db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(taskId);
        const children = taskId ? db.prepare('SELECT * FROM tasks WHERE parent_task_id=?').all(taskId).filter(t => verifiedChild(db, t)) : [];
        const outcome = row?.outcome ? JSON.parse(row.outcome) : null;
        const receipt = row?.receipt ? JSON.parse(row.receipt) : null;
        const observed = { status: task?.status ?? 'MISSING', children: children.length,
          outcome: outcome?.classification ?? (row?.state === 'CLOSED' ? 'UNKNOWN' : 'NONE'),
          receipt: receipt?.effect ?? 'NONE', effect: row?.observation ? JSON.parse(row.observation).effect : 'UNRESOLVED',
          ...(decision ? { decision } : {}) };
        if (authored) Object.assign(observed, { childTitle: children[0]?.title ?? '', childAssigneeId: children[0]?.assignee_id ?? '',
          reportStatus: typeof outcome?.result?.status === 'string' ? outcome.result.status : '', message: message ?? '' });
        const mismatches = Object.entries(action.expect).filter(([key, value]) => observed[key] !== value)
          .map(([key, expected]) => ({ path: `actions/${index}/${key}`, expected, observed: observed[key] ?? 'MISSING' }));
        // A child may not admit a reaction; every native child must have the exact receipt and origin.
        const roots = db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id IS NULL').get().n;
        const admissions = db.prepare('SELECT count(*) AS n FROM team_admissions').get().n;
        const unverified = db.prepare('SELECT * FROM tasks WHERE parent_task_id IS NOT NULL').all().some(t => !verifiedChild(db, t));
        if (admissions !== roots || unverified || [...writeCalls.values()].some(n => n > 1) || children.length > 1)
          mismatches.push({ path: 'native/no-cascade-or-retry', expected: true, observed: false });
        events.push({ action: action.op, ref: action.ref, expected: action.expect, observed, mismatches,
          ...(authored ? { before, covers: action.covers ?? null,
            binding: action.op === 'dispatch' ? 'TaskCreated' : action.op === 'complete' && !/\.(?:child|review)$/.test(action.ref) ? 'TaskBeforeComplete' : null } : {}),
          native: { taskId: taskId ?? null, eventId: row?.event_id ?? null, writeAttempts: writeCalls.get(row?.event_id) ?? 0,
            ...(authored ? { childId: children[0]?.id ?? null, admissionBefore } : {}),
            receipt, observation: row?.observation ? JSON.parse(row.observation) : null },
          // Native completion exposes the committed decision, not its internal Keir trace.
          // Keep the admitted TaskCreated outcome named separately; never call it the gate trace.
          runtime: { hook: 'TaskCreated', outcome } });
        if (Buffer.byteLength(json({ id: c.id, name: c.name, passed: events.every(e => !e.mismatches.length), events })) > 32768)
          throw new AppError(413, 'A simulation case report exceeds 32 KiB.');
      }
      results.push({ id: c.id, name: c.name, passed: events.every(e => !e.mismatches.length), events });
    } finally {
      lease.signal.removeEventListener('abort', stop);
      if (runtime) await (closing ?? runtime.close());
      db.close();
    }
  }
  lease.check();
  const report = { harness: TEAM_HARNESS, passed: results.every(c => c.passed), cases: results };
  if (Buffer.byteLength(json(report)) > 262144) throw new AppError(413, 'The simulation report exceeds 256 KiB.');
  return report;
}
