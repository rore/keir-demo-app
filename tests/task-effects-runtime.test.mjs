import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { TASK_HOOK } from '../src/extension-catalog.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

async function setup(t, { title = 'Customer follow-up', reportedStatus, clock } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'daymark-real-runtime-'));
  let db, dispatcher;
  t.after(async () => {
    await dispatcher?.close(); db?.close();
    assert.equal(dirname(directory), tmpdir()); assert.ok(directory.startsWith(join(tmpdir(), 'daymark-real-runtime-')));
    rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  });
  db = openData(join(directory, 'application.sqlite'));
  const native = taskService(db), owner = 'sam';
  const project = native.listProjects(owner)[0], other = native.createProject(owner, { name: 'Other customer project' });
  const fixture = taskCustomizationFixture({ projectId: project.id, otherProjectId: other.id, title });
  if (reportedStatus) {
    const source = JSON.parse(fixture.source); source.return.record.status.cel = JSON.stringify(reportedStatus);
    fixture.source = JSON.stringify(source);
    fixture.cases = fixture.cases.map(text => {
      const scenario = JSON.parse(text);
      if (scenario.expect.outcome.classification === 'COMPLETED') {
        scenario.expect.outcome.result.status = reportedStatus;
        scenario.expect.consumption.result.status = reportedStatus;
      }
      return JSON.stringify(scenario);
    });
  }
  const lifecycle = createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  dispatcher = createTaskDispatcher({ db, lifecycle, ...(clock && { clock }) });
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner });
  let state = await lifecycle.compile(owner, { extensionId, draftVersion: 0, hookId: TASK_HOOK, source: fixture.source, label: title }, () => {});
  state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.cases }, () => {});
  const revision = () => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await lifecycle.simulate(owner, revision(), () => {});
  assert.equal(state.evidence.passed, true, 'Independent expectations must pass using the exact compiled artifact.');
  state = lifecycle.approve(owner, { ...revision(), evidenceId: state.evidence.id }, () => {});
  return { db, native, owner, project, other, fixture, lifecycle, dispatcher, extensionId, revision,
    get state() { return state; },
    activate() {
      state = lifecycle.activate(owner, { ...revision(), generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
      return state;
    },
    disable() { state = lifecycle.disable(owner, { extensionId, generation: state.selection.generation }, () => {}); return state; } };
}

for (const title of ['Send the release checklist', 'Arrange a customer review']) {
  test(`actual runtime creates the source-owned task once: ${title}`, async t => {
    const f = await setup(t, { title });
    const before = f.native.listTasks(f.owner, f.project.id).length;
    f.activate();
    await f.dispatcher.wake();
    assert.equal(f.native.listTasks(f.owner, f.project.id).length, before, 'Approval and activation execute nothing.');
    const source = f.native.createTask(f.owner, { projectId: f.project.id, title: 'Complete me' });
    const completed = f.native.completeTask(f.owner, source.id);
    assert.equal(completed.status, 'completed');
    await f.dispatcher.wake();
    const status = f.dispatcher.status(f.owner, source.id);
    assert.equal(status.state, 'FINISHED');
    assert.equal(status.outcome.classification, 'COMPLETED');
    assert.deepEqual(status.outcome.effects, [{ step: 'created', capability: 'tasks.create', state: 'CONFIRMED' }]);
    assert.equal(status.receipt.effect, 'CONFIRMED');
    const created = f.native.getTask(f.owner, status.receipt.value.id);
    assert.equal(created.title, title); assert.equal(created.projectId, f.project.id); assert.equal(created.status, 'open');
    f.native.completeTask(f.owner, source.id); await f.dispatcher.wake();
    assert.deepEqual(f.dispatcher.status(f.owner, source.id), status);
    assert.equal(f.native.listTasks(f.owner, f.project.id).filter(task => task.title === title).length, 1);
    assert.throws(() => f.dispatcher.status('maya', source.id), error => error.status === 404);
    const reconciled = f.dispatcher.reconcile(f.owner, source.id);
    assert.deepEqual(reconciled.outcome, status.outcome);
    assert.deepEqual(reconciled.reconciliation.receipt, status.receipt);
    assert.ok(reconciled.reconciliation.observedAt);
    // Creating a task does not itself emit completion; a later explicit native completion can react.
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(created.id).n, 0);
    f.native.completeTask(f.owner, created.id); await f.dispatcher.wake();
    assert.equal(f.native.listTasks(f.owner, f.project.id).filter(task => task.title === title).length, 2);
    const original = f.db.prepare('SELECT event_id,original_key FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(source.id);
    const later = f.db.prepare('SELECT event_id,original_key FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(created.id);
    assert.notEqual(later.event_id, original.event_id); assert.notEqual(later.original_key, original.original_key);
    const saved = f.lifecycle.source(f.owner, f.state.draft.id, f.extensionId);
    const event = f.db.prepare('SELECT pins FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(source.id);
    assert.equal(JSON.parse(event.pins).artifactDigest, saved.pins.artifactDigest, 'Simulation and real admission retain the same artifact digest.');
  });
}

test('actual runtime nonmatch produces no task or receipt', async t => {
  const f = await setup(t); f.activate();
  const source = f.native.createTask(f.owner, { projectId: f.other.id, title: 'Unrelated task' });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  f.native.completeTask(f.owner, source.id); await f.dispatcher.wake();
  const status = f.dispatcher.status(f.owner, source.id);
  assert.equal(status.state, 'FINISHED');
  assert.deepEqual(status.outcome.effects, []);
  assert.deepEqual(status.outcome.result, { status: 'NO_OP' });
  assert.equal(status.receipt, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
});

test('a source-authored CREATED label cannot invent a native effect or receipt', async t => {
  const f = await setup(t, { reportedStatus: 'CREATED' }); f.activate();
  const source = f.native.createTask(f.owner, { projectId: f.other.id, title: 'Nonmatching source' });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  f.native.completeTask(f.owner, source.id); await f.dispatcher.wake();
  const status = f.dispatcher.status(f.owner, source.id);
  assert.deepEqual(status.outcome.result, { status: 'CREATED' });
  assert.deepEqual(status.outcome.effects, []); assert.equal(status.receipt, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
});

test('disable and reenable never revive an old native admission', async t => {
  const f = await setup(t); f.activate();
  const old = f.native.createTask(f.owner, { projectId: f.project.id, title: 'Old admission' });
  f.native.completeTask(f.owner, old.id);
  f.disable(); f.activate(); await f.dispatcher.dependenciesChanged();
  const stale = f.dispatcher.status(f.owner, old.id);
  assert.equal(stale.state, 'PENDING'); assert.equal(stale.outcome, null); assert.equal(stale.receipt, null);
  assert.ok(f.db.prepare('SELECT revoked_at FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(old.id).revoked_at);
  const fresh = f.native.createTask(f.owner, { projectId: f.project.id, title: 'New admission' });
  f.native.completeTask(f.owner, fresh.id); await f.dispatcher.wake();
  assert.equal(f.dispatcher.status(f.owner, fresh.id).receipt?.effect, 'CONFIRMED');
  assert.equal(f.native.listTasks(f.owner, f.project.id).filter(task => task.title === f.fixture.metadata.title).length, 1);
});

test('one current binding reuses its prepared handle with fresh event, owner, key, permission and deadline context', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    fileURLToPath(new URL('./fixtures/task-effects-reuse.mjs', import.meta.url))], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { boundVersions: ['3'], prepares: 1, invocations: 4,
    outcomes: ['CONFIRMED', 'NO_OP', 'REVOKED', 'EXPIRED'] });
});

test('native deadline expiry before commit rolls back the new task and receipt without replay', async t => {
  let now = 0;
  const f = await setup(t, { clock: () => now }); f.activate();
  f.db.function('expireNativeDeadline', () => { now = 1001; return 0; });
  f.db.exec('CREATE TEMP TRIGGER expire_task_effect AFTER INSERT ON task_effect_receipts BEGIN SELECT expireNativeDeadline(); END');
  const source = f.native.createTask(f.owner, { projectId: f.project.id, title: 'Complete with expiry' });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  f.native.completeTask(f.owner, source.id); await f.dispatcher.wake();
  const status = f.dispatcher.status(f.owner, source.id);
  assert.equal(status.state, 'FINISHED');
  assert.notEqual(status.outcome.classification, 'COMPLETED');
  assert.equal(status.outcome.effects.some(effect => effect.state === 'CONFIRMED'), false);
  assert.equal(status.receipt, null);
  assert.equal(f.native.getTask(f.owner, source.id).status, 'completed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
  assert.ok(f.db.prepare('SELECT revoked_at FROM task_events WHERE hook_id=\'TaskCompleted\' AND source_task_id=?').get(source.id).revoked_at);
  now = 0; await f.dispatcher.dependenciesChanged();
  assert.deepEqual(f.dispatcher.status(f.owner, source.id), status);
});

test('opaque native failure stays UNKNOWN until a separate read-only reconciliation and never retries', async t => {
  const f = await setup(t); f.activate();
  f.db.function('opaqueNativeFailure', () => { throw new Error('Isolated native failure'); });
  f.db.exec('CREATE TEMP TRIGGER fail_task_effect AFTER INSERT ON task_effect_receipts BEGIN SELECT opaqueNativeFailure(); END');
  const source = f.native.createTask(f.owner, { projectId: f.project.id, title: 'Complete with unavailable response' });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  assert.equal(f.native.completeTask(f.owner, source.id).status, 'completed');
  await f.dispatcher.wake();
  const status = f.dispatcher.status(f.owner, source.id);
  assert.equal(status.state, 'FINISHED');
  assert.deepEqual(status.outcome.effects, [{ step: 'created', capability: 'tasks.create', state: 'UNKNOWN' }]);
  assert.equal(status.receipt, null);
  const reconciled = f.dispatcher.reconcile(f.owner, source.id);
  assert.deepEqual(reconciled.outcome, status.outcome);
  assert.equal(reconciled.reconciliation.receipt, null); assert.ok(reconciled.reconciliation.observedAt);
  f.db.exec('DROP TRIGGER fail_task_effect');
  await f.dispatcher.dependenciesChanged();
  assert.deepEqual(f.dispatcher.status(f.owner, source.id), reconciled);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
});

test('failed outcome settlement keeps STARTED and a confirmed native receipt without claiming it never started', async t => {
  const f = await setup(t); f.activate();
  f.db.exec(`CREATE TEMP TRIGGER fail_outcome_settlement BEFORE UPDATE OF state ON task_events
    WHEN NEW.state='FINISHED' BEGIN SELECT RAISE(ABORT, 'Isolated outcome settlement failure'); END`);
  const source = f.native.createTask(f.owner, { projectId: f.project.id, title: 'Complete before failed settlement' });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  assert.equal(f.native.completeTask(f.owner, source.id).status, 'completed');
  await f.dispatcher.wake();
  const status = f.dispatcher.status(f.owner, source.id);
  assert.equal(status.state, 'STARTED'); assert.equal(status.outcome, null);
  assert.equal(status.receipt.kind, 'SUCCESS'); assert.equal(status.receipt.effect, 'CONFIRMED');
  assert.doesNotMatch(status.message ?? '', /not started/i);
  const created = f.native.getTask(f.owner, status.receipt.value.id);
  assert.equal(created.title, f.fixture.metadata.title); assert.equal(created.projectId, f.project.id); assert.equal(created.status, 'open');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before + 1);
  const rows = table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const tasks = rows('tasks'), receipts = rows('task_effect_receipts'), events = rows('task_events');
  assert.equal(receipts.length, 1);
  assert.deepEqual(f.dispatcher.status(f.owner, source.id), status);
  assert.deepEqual(rows('task_events'), events, 'Status reads never settle or reexecute an interrupted reaction.');
  const reconciled = f.dispatcher.reconcile(f.owner, source.id);
  assert.equal(reconciled.state, 'STARTED'); assert.equal(reconciled.outcome, null);
  assert.deepEqual(reconciled.receipt, status.receipt); assert.deepEqual(reconciled.reconciliation.receipt, status.receipt);
  assert.ok(reconciled.reconciliation.observedAt); assert.doesNotMatch(reconciled.message ?? '', /not started/i);
  assert.deepEqual(rows('tasks'), tasks); assert.deepEqual(rows('task_effect_receipts'), receipts);
  f.db.exec('DROP TRIGGER fail_outcome_settlement');
  await f.dispatcher.dependenciesChanged();
  f.native.completeTask(f.owner, source.id); await f.dispatcher.wake();
  assert.deepEqual(f.dispatcher.status(f.owner, source.id), reconciled);
  assert.deepEqual(rows('tasks'), tasks); assert.deepEqual(rows('task_effect_receipts'), receipts);
  assert.equal(rows('task_events').length, events.length, 'Repeated completion cannot capture or replay a second event.');
});
