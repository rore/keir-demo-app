import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, resetData, taskService } from '../src/data.mjs';
import { createTeamRuntime, installTeamRevision } from '../src/team-runtime.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { compileTeamFixture, compileTeamProgram, seedTeamFixture } from '../scripts/team-native-fixture.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createApp } from '../src/app.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { taskEffectSyntax, taskEffectScenarioExamples } from '../src/task-effect-simulation.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { taskWorkflowSource, taskWorkflowCases } from './fixtures/task-workflow-source.mjs';

let compiled;
const assets = () => compiled ??= compileTeamFixture();
async function setup(t, options = {}, path = ':memory:') {
  const db = openData(path), project = seedTeamFixture(db, await assets());
  const runtime = createTeamRuntime({ db, ...options }), tasks = taskService(db, { team: runtime });
  t.after(async () => { await runtime.close(); db.close(); });
  const create = (actor = 'maya', title = 'Deliverable', context = {}) =>
    tasks.createTask(actor, { projectId: project, title }, { operationId: randomUUID(), ...context });
  const child = root => tasks.listTasks('maya', project).find(task => task.parentTaskId === root.id);
  return { db, project, runtime, tasks, create, child, admin: teamProjectService(db) };
}
const missing = fn => assert.throws(fn, { status: 404 });

for (const boundary of ['aborted', 'expired', 'before task write', 'after task write', 'after CREATED result',
  'cancelled after task write', 'cancelled after CREATED result']) {
  test(`Team create lease rejects ${boundary} without saving a task, admission or CREATED result`, async t => {
    const f = await setup(t), operationId = randomUUID(), controller = new AbortController();
    let now = 0;
    const context = { operationId, signal: controller.signal, deadline: { clock: { nowMs: () => now }, expiresAtMs: 1000 } };
    if (boundary === 'aborted') controller.abort();
    if (boundary === 'expired') now = 1000;
    if (boundary.includes('write') || boundary.endsWith('CREATED result')) {
      f.db.function('expire_team_create', () => {
        if (boundary.startsWith('cancelled')) controller.abort();
        else now = 1000;
        return null;
      });
      const timing = boundary === 'before task write' ? 'BEFORE' : 'AFTER';
      const table = boundary.endsWith('CREATED result') ? 'task_create_operations' : 'tasks';
      const condition = table === 'tasks' ? `NEW.project_id='${f.project}'`
        : "json_extract(CAST(NEW.result AS TEXT),'$.state')='CREATED'";
      f.db.exec(`CREATE TEMP TRIGGER expire_team_create ${timing} INSERT ON ${table}
        WHEN ${condition} BEGIN SELECT expire_team_create(); END`);
    }
    await assert.rejects(() => f.create('leo', 'Expired Team attempt', context),
      { status: 409, code: 'STALE_ATTEMPT', state: 'NOT_CREATED' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(f.project).n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_admissions WHERE project_id=?').get(f.project).n, 0);
    const result = f.tasks.getCreateOperation('leo', operationId);
    assert.equal(result.state, 'NOT_CREATED');
    assert.equal(result.code, 'STALE_ATTEMPT');
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM task_create_operations
      WHERE json_extract(CAST(result AS TEXT),'$.state')='CREATED'`).get().n, 0);
  });
}

test('Team create lease preserves a committed replay even when the new request is aborted and expired', async t => {
  const f = await setup(t), operationId = randomUUID(), input = { projectId: f.project, title: 'Committed Team attempt' };
  const tasks = taskService(f.db, { guard: { check() { assert.fail('Team creation must not run Personal policy'); } } });
  const committed = await tasks.createTask('leo', input, { operationId });
  const before = ['tasks', 'team_admissions', 'task_create_operations'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const stale = { operationId, signal: AbortSignal.abort(), deadline: { clock: { nowMs: () => 1000 }, expiresAtMs: 1000 } };
  assert.deepEqual(await tasks.createTask('leo', input, stale), committed);
  assert.deepEqual(tasks.getCreateOperation('leo', operationId, stale).task, committed);
  assert.deepEqual(['tasks', 'team_admissions', 'task_create_operations'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
});

test('a wake during a held first effect drains later roots without an unrelated wake or restart', async t => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const f = await setup(t, { async beforeEffectCommit() { if (++calls === 1) { entered(); await held; } } });
  const first = await f.create(), firstWake = f.runtime.wake();
  await started;
  const second = await f.create(), secondWake = f.runtime.wake();
  release();
  await Promise.all([firstWake, secondWake]);
  assert.equal(f.runtime.status('maya', first.id).state, 'FINISHED');
  assert.equal(f.runtime.status('maya', second.id).state, 'FINISHED');
  assert.ok(f.child(first)); assert.ok(f.child(second)); assert.equal(calls, 2);
});

test('two users execute real pinned rules, native linked task and version replacement without Personal events', async t => {
  const f = await setup(t), root = await f.create('leo'), old = await f.create();
  assert.equal(root.creatorId, 'leo');
  assert.equal(f.db.prepare('SELECT owner_id FROM tasks WHERE id=?').get(root.id).owner_id, 'maya');
  assert.ok(f.tasks.listProjects('leo').some(project => project.id === f.project));
  await f.runtime.wake();
  assert.equal(f.child(root).assigneeId, 'leo');
  assert.equal(f.runtime.status('leo', root.id).outcome.classification, 'COMPLETED');
  await assert.rejects(() => f.tasks.completeTask('leo', root.id), { status: 422 });
  missing(() => f.tasks.getTask('sam', root.id));
  assert.throws(() => f.tasks.editTask('leo', old.id, { priority: 'high' }), { status: 403 });
  assert.throws(() => f.admin.setSelection('leo', f.project, null), { status: 403 });
  f.admin.setSelection('maya', f.project, 'review-v2');
  const replacement = await f.create();
  await f.runtime.wake();
  assert.equal(f.child(replacement).title, 'Check the revised deliverable');
  assert.equal(f.child(replacement).assigneeId, 'maya');
  assert.equal(f.child(old).title, 'Review deliverable');
  f.admin.setSelection('maya', f.project, null);
  const uncovered = await f.create();
  assert.equal((await f.tasks.completeTask('maya', uncovered.id)).status, 'completed');
  await assert.rejects(() => f.tasks.completeTask('maya', old.id), { status: 422 });
  await f.tasks.completeTask('leo', f.child(old).id);
  const completed = await f.tasks.completeTask('maya', old.id);
  assert.equal(completed.status, 'completed');
  f.admin.revoke('maya', f.project, 'review-v1');
  assert.deepEqual(await f.tasks.completeTask('maya', old.id), completed, 'Repeating a completed action does not reevaluate a gate or undo saved work');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id IN (SELECT id FROM tasks WHERE project_id=?)').get(f.project).n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_admissions WHERE project_id=?').get(f.project).n, 4, 'No cascade from effect-created children');
  assert.throws(() => f.db.prepare('UPDATE tasks SET origin_event_id=NULL WHERE id=?').run(f.child(root).id), /immutable/);
  assert.throws(() => f.db.prepare("UPDATE team_revisions SET artifacts='{}' WHERE project_id=?").run(f.project), /immutable/);
});

for (const change of ['fact', 'initiator', 'assignee', 'revocation', 'deadline', 'closed-claim']) {
  test(`native effect commit fences ${change} after evaluation and leaves no child or confirmed receipt`, async t => {
    let now = 0;
    const f = await setup(t, { clock: () => now, beforeEffectCommit({ eventId }) {
      if (change === 'fact') f.db.prepare("UPDATE tasks SET priority='high' WHERE id=(SELECT source_task_id FROM team_admissions WHERE event_id=?)").run(eventId);
      if (change === 'initiator') f.db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='maya'").run(f.project);
      if (change === 'assignee') f.db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(f.project);
      if (change === 'revocation') f.admin.revoke('maya', f.project, 'review-v1');
      if (change === 'deadline') now = 1000;
      if (change === 'closed-claim') f.db.prepare("UPDATE team_admissions SET state='CLOSED' WHERE event_id=?").run(eventId);
    } });
    const root = await f.create();
    await f.runtime.wake();
    const row = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(root.id);
    assert.equal(row.state, 'CLOSED');
    assert.equal(row.child_id, null);
    assert.equal(row.receipt, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id=?').get(root.id).n, 0);
  });
}

test('an original invocation held across a durable close cannot commit after a settled no-write reconciliation', async t => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { async beforeEffectCommit() { entered(); await held; } });
  const root = await f.create(), running = f.runtime.wake();
  await started;
  f.db.prepare("UPDATE team_admissions SET state='CLOSED' WHERE source_task_id=?").run(root.id);
  assert.equal(f.runtime.reconcile('maya', root.id).reconciliation.effect, 'NONE');
  release(); await running;
  assert.equal(f.runtime.reconcile('maya', root.id).reconciliation.effect, 'NONE');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id=?').get(root.id).n, 0);
});

test('missing required artifact, revision or completion binding is not the intentionally absent-hook case', async t => {
  for (const missingState of ['artifact', 'revision', 'binding']) {
    const f = await setup(t), root = await f.create();
    await f.runtime.wake();
    await f.tasks.completeTask('leo', f.child(root).id);
    if (missingState === 'artifact') {
      f.db.exec('DROP TRIGGER team_revision_immutable');
      f.db.prepare("UPDATE team_revisions SET artifacts='{}' WHERE project_id=?").run(f.project);
    }
    if (missingState === 'revision') {
      f.db.exec('PRAGMA foreign_keys=OFF');
      f.db.prepare("DELETE FROM team_revisions WHERE project_id=? AND revision_id='review-v1'").run(f.project);
      f.db.exec('PRAGMA foreign_keys=ON');
    }
    await assert.rejects(async () => (missingState === 'binding' ? taskService(f.db) : f.tasks).completeTask('maya', root.id), { status: 503 });
    assert.equal(f.tasks.getTask('maya', root.id).status, 'open');
  }
});
test('Team replay, search and saved effects recheck current membership including non-owner member', async t => {
  const f = await setup(t), operationId = randomUUID(), input = { projectId: f.project, title: 'Shared work' };
  const root = await f.tasks.createTask('leo', input, { operationId });
  assert.equal((await f.tasks.createTask('leo', input, { operationId })).id, root.id);
  assert.equal(f.tasks.getCreateOperation('leo', operationId).task.id, root.id);
  await f.runtime.wake();
  assert.equal(f.tasks.searchTasks('leo', f.project, { q: 'Shared' }).items[0].id, root.id);
  const foreign = f.tasks.listTasks('leo', f.tasks.listProjects('leo').find(project => project.mode === 'PERSONAL').id)[0];
  missing(() => f.tasks.searchTasks('leo', f.project, { q: 'Shared', after: foreign.id }));
  assert.throws(() => f.admin.removeMember('maya', f.project, 'leo'), { status: 409 });
  // Test revocation by an independent native authority change, not an allowed orphaning UI action.
  f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.project, 'leo');
  for (const action of [
    () => f.tasks.getTask('leo', root.id), () => f.tasks.listTasks('leo', f.project),
    () => f.tasks.searchTasks('leo', f.project, { q: 'Shared' }), () => f.tasks.getCreateOperation('leo', operationId),
    () => f.runtime.status('leo', root.id), () => f.runtime.reconcile('leo', root.id),
  ]) missing(action);
  await assert.rejects(() => f.tasks.createTask('leo', input, { operationId }), { status: 404 });
});

test('manual matching text cannot satisfy immutable child provenance; missing admission fails closed', async t => {
  const f = await setup(t), root = await f.create();
  await f.runtime.wake();
  f.admin.setSelection('maya', f.project, null);
  const decoy = await f.create('maya', f.child(root).title);
  await f.tasks.completeTask('maya', decoy.id);
  const now = new Date().toISOString();
  f.db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at,creator_id,parent_task_id)
    VALUES (?,'maya',?,?,'','completed',?,?,?,'maya',?)`).run(randomUUID(), f.project, f.child(root).title, now, now, now, root.id);
  await assert.rejects(() => f.tasks.completeTask('maya', root.id), { status: 422 });
  const orphan = await f.create();
  f.db.prepare('DELETE FROM team_admissions WHERE source_task_id=?').run(orphan.id);
  await assert.rejects(() => f.tasks.completeTask('maya', orphan.id), { status: 503 });
  installTeamRevision(f.db, 'maya', f.project, 'no-hooks', { TaskCreated: null, TaskBeforeComplete: null });
  f.admin.setSelection('maya', f.project, 'no-hooks');
  const noHooks = await f.create();
  assert.equal((await f.tasks.completeTask('maya', noHooks.id)).status, 'completed');
  await assert.rejects(() => f.tasks.completeTask('maya', root.id, { deadline: { clock: { nowMs: () => 5 }, expiresAtMs: 5 } }), { status: 409 });
});

for (const change of ['fact', 'membership', 'revocation', 'session', 'deadline']) {
  test(`completion rechecks ${change} after real ALLOW and before native write`, async t => {
    let armed = false, now = 0;
    const f = await setup(t, { beforeCompleteCommit({ taskId }) {
      if (!armed) return;
      if (change === 'fact') f.db.prepare("UPDATE tasks SET status='open',completed_at=NULL WHERE id=?").run(f.child({ id: taskId }).id);
      if (change === 'membership') f.db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(f.project);
      if (change === 'revocation') f.admin.revoke('maya', f.project, 'review-v1');
      if (change === 'deadline') now = 1000;
    } });
    const root = await f.create('leo');
    await f.runtime.wake();
    await f.tasks.completeTask('leo', f.child(root).id);
    armed = true;
    let authCalls = 0;
    await assert.rejects(() => f.tasks.completeTask('leo', root.id, {
      authorize: () => change === 'session' && ++authCalls > 2 ? 'sam' : 'leo',
      deadline: { clock: { nowMs: () => now }, expiresAtMs: 1000 },
    }));
    assert.equal(f.tasks.getTask('maya', root.id).status, 'open');
  });
}

for (const committed of [true, false]) {
  test(`native reply loss with committed=${committed} reconciles after restart without invoking or retrying`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'team-recovery-')), path = join(directory, 'app.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let db = openData(path), calls = 0;
    const project = seedTeamFixture(db, await assets());
    let runtime = createTeamRuntime({ db,
      beforeEffectCommit() { calls++; if (!committed) throw new Error('Reply lost before write'); },
      effectReply() { return { kind: 'UNKNOWN_COMMIT', effect: 'UNKNOWN' }; },
    });
    const tasks = taskService(db, { team: runtime }), root = await tasks.createTask('maya', { projectId: project, title: 'Recover original key' }, { operationId: randomUUID() });
    await runtime.wake();
    const first = runtime.status('maya', root.id), key = first.originalKey;
    assert.equal(first.outcome.classification, 'UNCERTAIN');
    await runtime.close(); db.close();
    db = openData(path); runtime = createTeamRuntime({ db, beforeEffectCommit() { assert.fail('Reconcile invoked a rule'); } });
    try {
      const result = runtime.reconcile('maya', root.id);
      assert.equal(result.originalKey, key);
      assert.equal(result.reconciliation.effect, committed ? 'CONFIRMED' : 'NONE');
      assert.equal(result.outcome.classification, 'UNCERTAIN', 'Observation does not rewrite runtime outcome');
      await runtime.wake();
      assert.equal(calls, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id=?').get(root.id).n, committed ? 1 : 0);
      if (!committed) await assert.rejects(() => taskService(db, { team: runtime }).completeTask('maya', root.id), { status: 422 });
    } finally { await runtime.close(); db.close(); }
  });
}

test('Personal automation cannot project or mutate Team data even for its project owner', async t => {
  const f = await setup(t), root = await f.create(), personal = f.tasks.listProjects('maya').find(project => project.mode === 'PERSONAL');
  missing(() => f.tasks.getTaskForCustomization('maya', root.id));
  missing(() => f.tasks.hasOpenTask('maya', f.project, root.title, { clock: { nowMs: () => 0 }, expiresAtMs: 100 }));
  const lifecycle = createLifecycle(f.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  const host = loadHost('TaskCompleted'), options = { projectId: personal.id, destinationProjectId: f.project };
  async function activate(source, cases) {
    const { extensionId } = admitTaskDraft(f.db, lifecycle, { owner: 'maya', name: 'Cross-domain rejection check' });
    const draft = await lifecycle.compile('maya', { extensionId, hookId: 'TaskCompleted', draftVersion: 0, source }, () => {});
    const input = state => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
    const saved = await lifecycle.proposeScenarios('maya', { ...input(draft), cases }, () => {});
    const checked = await lifecycle.simulate('maya', input(saved), () => {});
    assert.equal(checked.evidence?.passed, true, JSON.stringify(checked.evidence));
    const evidenceId = checked.evidence.id;
    lifecycle.approve('maya', { ...input(checked), evidenceId }, () => {});
    lifecycle.activate('maya', { ...input(checked), generation: checked.selection.generation, evidenceId }, () => {});
  }
  await activate(taskWorkflowSource(host, 'review', options).toString(), taskWorkflowCases(host, 'review', options));
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle });
  try {
    const task = await f.tasks.createTask('maya', { projectId: personal.id, title: 'Personal work', priority: 'high', tags: ['review'] }, { operationId: randomUUID() });
    f.tasks.completeTask('maya', task.id);
    await dispatcher.wake();
    const outcome = dispatcher.status('maya', task.id);
    assert.equal(outcome.receipt.effect, 'NONE');
    assert.equal(outcome.receipt.code, 'PROJECT_NOT_FOUND', 'Real saved Personal rule attempted a Team-targeted native create');
    const source = JSON.parse(taskEffectSyntax(host));
    source.steps.find(step => step.call === 'tasks.get').args.taskId = { literal: root.id, type: 'TaskId' };
    const cases = taskEffectScenarioExamples(host).map(text => text.replaceAll('"task1"', JSON.stringify(root.id)));
    await activate(JSON.stringify(source), cases);
    const next = await f.tasks.createTask('maya', { projectId: personal.id, title: 'Personal read attempt' }, { operationId: randomUUID() });
    f.tasks.completeTask('maya', next.id);
    await dispatcher.dependenciesChanged();
    assert.notEqual(dispatcher.status('maya', next.id).outcome.classification, 'COMPLETED', 'Real Personal runtime cannot read a Team task');
    assert.equal(f.tasks.getTask('maya', root.id).status, 'open');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(f.project).n, 1);
  } finally { await dispatcher.close(); }
});

test('real Team rules cannot read or create in Personal scope despite shared human membership', async t => {
  const f = await setup(t), personal = f.tasks.listProjects('maya').find(project => project.mode === 'PERSONAL');
  const personalTask = f.tasks.listTasks('maya', personal.id)[0];
  const program = JSON.parse(readFileSync(new URL('../keir/team-review-v1.json', import.meta.url)))[0];
  for (const capability of ['read', 'write']) {
    const destinationBefore = f.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY id').all(personal.id);
    const hostile = structuredClone(program);
    if (capability === 'read') hostile.steps[0].args.taskId = { literal: personalTask.id, type: 'TaskId' };
    else hostile.steps[1].args.projectId = { literal: personal.id, type: 'ProjectId' };
    const created = await compileTeamProgram(hostile), revisionId = 'cross-' + capability;
    installTeamRevision(f.db, 'maya', f.project, revisionId,
      { TaskCreated: created, TaskBeforeComplete: (await assets()).first.TaskBeforeComplete });
    f.admin.setSelection('maya', f.project, revisionId);
    const root = await f.create();
    await f.runtime.wake();
    assert.equal(f.child(root), undefined);
    assert.notEqual(f.runtime.status('maya', root.id).outcome?.classification, 'COMPLETED');
    assert.deepEqual(f.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY id').all(personal.id), destinationBefore,
      'An uncertain or rejected outcome is not proof that the foreign destination was untouched');
  }
});

test('a postcommit authority change does not erase the original runtime result or the native receipt', async t => {
  const f = await setup(t, { effectReply(result) {
    f.db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(f.project);
    return result;
  } });
  const root = await f.create('leo');
  await f.runtime.wake();
  const saved = f.db.prepare('SELECT outcome,receipt,child_id FROM team_admissions WHERE source_task_id=?').get(root.id);
  assert.equal(JSON.parse(saved.outcome).classification, 'COMPLETED');
  assert.equal(JSON.parse(saved.receipt).effect, 'CONFIRMED');
  assert.ok(saved.child_id);
  missing(() => f.runtime.status('leo', root.id));
  assert.equal(f.runtime.reconcile('maya', root.id).reconciliation.effect, 'CONFIRMED');
});

test('confirmed disposable reset backs up Team origins and receipts and restores only Personal defaults', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'team-reset-')), path = join(directory, 'app.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = openData(path);
  const project = seedTeamFixture(db, await assets()), runtime = createTeamRuntime({ db });
  const tasks = taskService(db, { team: runtime });
  const root = await tasks.createTask('maya', { projectId: project, title: 'Back up linked work' }, { operationId: randomUUID() });
  await runtime.wake();
  const admission = db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(root.id);
  assert.ok(admission.receipt);
  await runtime.close(); db.close();
  const backup = await resetData(directory, true);
  const saved = openData(backup);
  try {
    assert.deepEqual(saved.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(root.id), admission);
    assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(saved.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { saved.close(); }
  db = openData(path);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM team_admissions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_members').get().n, 0);
    assert.deepEqual(db.prepare('SELECT DISTINCT mode FROM projects').all().map(Object.values), [['PERSONAL']]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

test('HTTP covers non-owner member reads, create replay, current access and two-user completion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'team-http-')), db = openData(':memory:');
  const project = seedTeamFixture(db, await assets()), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin, staticRoot: directory, authoring: { config: readAuthoringConfig({}) } });
  t.after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  await app.ready();
  async function signIn(userId) {
    const bootstrap = await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:32123' } });
    const result = await app.inject({ method: 'POST', url: '/api/session',
      headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', 'x-session-context': bootstrap.json().contextToken },
      payload: { userId } });
    assert.equal(result.statusCode, 200, result.body);
    return { cookie: `keir_demo_session=${result.cookies[0].value}`, 'x-session-context': result.json().contextToken };
  }
  const maya = await signIn('maya'), leo = await signIn('leo'), sam = await signIn('sam');
  const request = (actor, method, url, payload, extra = {}) => app.inject({ method, url,
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...actor, ...extra }, ...(payload === undefined ? {} : { payload }) });
  const operationId = randomUUID(), input = { projectId: project, title: 'HTTP deliverable' };
  const response = await request(leo, 'POST', '/api/tasks', input, { 'x-task-create-id': operationId });
  assert.equal(response.statusCode, 201, response.body);
  const root = response.json(), detail = `/api/tasks/${root.id}`;
  for (const url of [`/api/projects/${project}/tasks`, `/api/projects/${project}/tasks/search?q=HTTP`, detail,
    `/api/task-create-operations/${operationId}`]) assert.equal((await request(leo, 'GET', url)).statusCode, 200, url);
  assert.equal((await request(leo, 'POST', '/api/tasks', input, { 'x-task-create-id': operationId })).json().id, root.id);
  assert.equal((await request(sam, 'GET', detail)).statusCode, 404);
  assert.equal((await request(leo, 'PATCH', `/api/projects/${project}`, { name: 'Stolen' })).statusCode, 403);
  assert.equal((await request(leo, 'POST', '/api/tasks', { ...input, originEventId: 'forged' }, { 'x-task-create-id': randomUUID() })).statusCode, 400);
  for (let tries = 0; tries < 100 && db.prepare('SELECT state FROM team_admissions WHERE source_task_id=?').get(root.id).state !== 'CLOSED'; tries++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request(leo, 'POST', detail + '/complete', {})).statusCode, 422);
  const child = db.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.id);
  assert.ok(child, 'Actual native child must exist');
  assert.equal((await request(leo, 'POST', `/api/tasks/${child.id}/complete`, {})).statusCode, 200);
  assert.equal((await request(leo, 'POST', detail + '/complete', {})).statusCode, 200);
  assert.equal((await request(maya, 'GET', detail + '/reaction?trigger=TaskCreated')).json().receipt.effect, 'CONFIRMED');
  const savedAdmission = db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(root.id);
  for (const suffix of ['', '?trigger=TaskCompleted']) {
    const completionReaction = await request(maya, 'GET', detail + '/reaction' + suffix);
    assert.equal(completionReaction.statusCode, 200);
    assert.deepEqual(completionReaction.json(), { state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null },
      'A completed Team task exposes its creation evidence only under TaskCreated, not twice');
    assert.equal((await request(maya, 'POST', detail + '/reaction/reconcile' + suffix, {})).statusCode, 404);
  }
  assert.deepEqual(db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(root.id), savedAdmission,
    'A completion projection cannot reconcile or change the saved creation admission');
  assert.equal((await request(maya, 'POST', detail + '/reaction/reconcile?trigger=TaskCreated', {})).json().reconciliation.effect, 'CONFIRMED');
  db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(project);
  for (const url of [detail, detail + '/reaction?trigger=TaskCreated', `/api/projects/${project}/tasks`,
    `/api/projects/${project}/tasks/search?q=HTTP`, `/api/task-create-operations/${operationId}`])
    assert.equal((await request(leo, 'GET', url)).statusCode, 404, url);
  assert.equal((await request(leo, 'POST', detail + '/reaction/reconcile?trigger=TaskCreated', {})).statusCode, 404);
  assert.equal((await request(leo, 'POST', '/api/tasks', input, { 'x-task-create-id': operationId })).statusCode, 404);
});
