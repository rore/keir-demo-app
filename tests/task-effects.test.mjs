import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService, transaction, revokeTaskAdmissions } from '../src/data.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { loadHost, TASK_HOOK } from '../src/extension-catalog.mjs';
import { nativeEffectService, seedTaskEffectBinding } from './fixtures/task-effect-schema.mjs';

// Synthetic native storage setup; no synthetic artifact is bound or invoked.
function fixture(t) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const tasks = taskService(db), host = loadHost(TASK_HOOK);
  const binding = seedTaskEffectBinding(db), pins = binding.pins;
  const revision = { id: binding.revisionId, extension_id: binding.extensionId };
  db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'")
    .run(revision.id, JSON.stringify(pins));
  const projectId = tasks.listProjects('maya')[0].id;
  const effects = nativeEffectService(db);
  function complete() {
    const task = tasks.createTask('maya', { projectId, title: 'Dispatcher source' });
    tasks.completeTask('maya', task.id);
    return effects.status('maya', db.prepare('SELECT event_id FROM task_completion_events WHERE source_task_id=?').get(task.id).event_id);
  }
  return { db, tasks, effects, complete, host, pins, projectId, revision };
}

test('PENDING scan crosses blocked pages, skips revoked/STARTED, and retries dependencies only on explicit change', async t => {
  const f = fixture(t), events = Array.from({ length: 191 }, () => f.complete());
  const revoked = new Set(events.slice(140, 165).map(event => event.eventId));
  for (const eventId of revoked) f.db.prepare('UPDATE task_completion_events SET revoked_at=1 WHERE event_id=?').run(eventId);
  const started = f.complete();
  assert.ok(f.effects.claim('maya', started.eventId));
  const visits = [];
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle: {
    execution(owner, revisionId, itemId) {
      assert.equal(owner, 'maya'); assert.equal(revisionId, f.revision.id); assert.equal(itemId, f.revision.extension_id);
      // Discovery is observable without preparing or invoking a synthetic artifact.
      visits.push(owner);
      return null;
    },
    admissionCurrent() { assert.fail('Unavailable dependencies must never reach claim/write authority'); },
  } });
  t.after(() => dispatcher.close());
  await dispatcher.wake();
  assert.equal(visits.length, events.length - revoked.size);
  await Promise.all([dispatcher.wake(), dispatcher.wake()]);
  assert.equal(visits.length, 166, 'unchanged dependencies must not retry even after the 128-entry cache bound');
  const later = f.complete();
  await dispatcher.wake();
  assert.equal(visits.length, 167, 'new work beyond the old cursor is discovered');
  await dispatcher.dependenciesChanged();
  assert.equal(visits.length, 334, 'one explicit dependency transition retries each eligible admission once');
  await dispatcher.wake();
  assert.equal(visits.length, 334);
  assert.equal(f.effects.status('maya', started.eventId).state, 'STARTED');
  assert.equal(f.effects.status('maya', later.eventId).state, 'PENDING');
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM task_completion_events WHERE outcome IS NOT NULL").get().n, 0);
});

test('execution discovery failures do not starve later PENDING work or spin on the next wake', async t => {
  const f = fixture(t);
  for (let i = 0; i < 65; ++i) f.complete();
  let visits = 0, later = 0;
  const dispatcher = createTaskDispatcher({ db: f.db,
    lifecycle: { execution() { if (++visits <= 45) throw new Error('TEST unavailable dependency'); ++later; return null; } } });
  t.after(() => dispatcher.close());
  await dispatcher.wake();
  assert.equal(visits, 65); assert.equal(later, 20);
  await dispatcher.wake();
  assert.equal(visits, 65);
  await dispatcher.close(); await dispatcher.wake();
  assert.equal(visits, 65);
});

test('status is owner-scoped and read-only, and retained CONFIRMED audit survives unavailable dependencies and revocation', async t => {
  const f = fixture(t), event = f.complete();
  assert.ok(f.effects.claim('maya', event.eventId));
  const receipt = f.effects.createTaskOnce('maya', f.effects.keyFor('maya', event.eventId), { projectId: f.projectId, title: 'Saved native result' });
  const outcome = { classification: 'FAILED', error: { code: 'OUTPUT_INVALID' }, effects: [{ effect: 'CONFIRMED' }] };
  f.effects.finish('maya', event.eventId, outcome);
  transaction(f.db, () => revokeTaskAdmissions(f.db, 'maya', f.revision.extension_id));
  let executions = 0;
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle: { execution() { ++executions; throw new Error('Unavailable'); } } });
  t.after(() => dispatcher.close());
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const status = dispatcher.status('maya', event.sourceTaskId);
  assert.equal(status.state, 'FINISHED'); assert.deepEqual(status.outcome, outcome); assert.deepEqual(status.receipt, receipt);
  assert.equal(status.reconciliation, null);
  assert.deepEqual(dispatcher.status('maya', event.sourceTaskId), status);
  assert.throws(() => dispatcher.status('leo', event.sourceTaskId), error => error.status === 404);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(executions, 0);
  const reconciled = dispatcher.reconcile('maya', event.sourceTaskId);
  assert.deepEqual(reconciled.outcome, outcome); assert.deepEqual(reconciled.receipt, receipt);
  assert.ok(reconciled.reconciliation); assert.equal(executions, 0);
  await dispatcher.wake();
  assert.equal(executions, 0);
});

test('native CRUD remains usable with unavailable dependencies and status cannot schedule execution', async t => {
  const f = fixture(t), event = f.complete();
  let executions = 0;
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle: { execution() { ++executions; return null; } } });
  t.after(() => dispatcher.close());
  assert.equal(dispatcher.status('maya', event.sourceTaskId).state, 'PENDING');
  assert.equal(executions, 0);
  await dispatcher.wake(); assert.equal(executions, 1);
  assert.equal(f.tasks.editTask('maya', event.sourceTaskId, { title: 'Native edit', notes: 'Kept' }).notes, 'Kept');
  assert.equal(f.tasks.createTask('maya', { projectId: f.projectId, title: 'Independent CRUD' }).status, 'open');
  assert.equal(dispatcher.status('maya', event.sourceTaskId).state, 'PENDING');
  assert.equal(executions, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n, 0);
});

test('old contract PENDING stays held before discovery and STARTED, revocation and settled bytes never replay', async t => {
  const f = fixture(t), oldPins = { ...f.pins, profile: 'keir-effect/3', definitionId: 'daymark.task-completed/1',
    modelRef: { ...f.pins.modelRef, format: 'keir-dcm/effect-3' } };
  f.db.prepare("UPDATE extension_selections SET binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'").run(JSON.stringify(oldPins));
  const pending = f.complete(), started = f.complete(), revoked = f.complete(), finished = f.complete();
  f.db.prepare("UPDATE task_completion_events SET state='STARTED' WHERE event_id IN (?,?)").run(started.eventId, finished.eventId);
  f.effects.finish('maya', finished.eventId, { classification: 'UNCERTAIN', effects: [] });
  f.db.prepare('UPDATE task_completion_events SET revoked_at=1 WHERE event_id=?').run(revoked.eventId);
  const before = f.db.prepare('SELECT * FROM task_completion_events ORDER BY rowid').all();
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle: { execution() { assert.fail('Old profile must be held before discovery or claim'); } } });
  t.after(() => dispatcher.close());
  await dispatcher.wake(); await dispatcher.dependenciesChanged();
  assert.deepEqual(f.db.prepare('SELECT * FROM task_completion_events ORDER BY rowid').all(), before);
  assert.equal(f.effects.status('maya', pending.eventId).state, 'PENDING');
  assert.equal(f.effects.status('maya', started.eventId).state, 'STARTED');
  assert.deepEqual(dispatcher.status('maya', finished.sourceTaskId).outcome, { classification: 'UNCERTAIN', effects: [] });
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n, 0);
});
