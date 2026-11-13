import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openData, taskService, taskEffectService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadHost, TASK_EVENT_HOOKS } from '../src/extension-catalog.mjs';
import { taskEffectScenarioExamples, taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { taskWorkflowCases, taskWorkflowSource } from './fixtures/task-workflow-source.mjs';

const owner = 'maya';
const authorize = () => {};

async function approveAndActivate(db, lifecycle, hookId, projectId, workflow, options) {
  const host = loadHost(hookId);
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner, name: hookId });
  const replaceProject = text => text.replaceAll('"project1"', JSON.stringify(projectId));
  const source = workflow ? taskWorkflowSource(host, workflow, options).toString('utf8') : replaceProject(taskEffectSyntax(host));
  const cases = workflow ? taskWorkflowCases(host, workflow, options) : taskEffectScenarioExamples(host).map(replaceProject);
  const draft = await lifecycle.compile(owner, { extensionId, hookId, draftVersion: 0, source }, authorize);
  const input = state => ({ extensionId, draftVersion: state.draftVersion, revisionId: state.draft.id });
  const saved = await lifecycle.proposeScenarios(owner, { ...input(draft), cases }, authorize);
  const verified = await lifecycle.simulate(owner, input(saved), authorize);
  assert.equal(verified.evidence?.passed, true, JSON.stringify(verified.evidence));
  const evidenceId = verified.evidence.id;
  assert.equal(lifecycle.approve(owner, { ...input(verified), evidenceId }, authorize).selection.revision, null);
  return lifecycle.activate(owner, { ...input(verified), generation: verified.selection.generation, evidenceId }, authorize);
}

test('both approved event selections execute exact current artifacts through native dispatch', async () => {
  const db = openData(':memory:'), tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const lifecycle = createLifecycle(db, { compiler: createCompiler() });
  const dispatcher = createTaskDispatcher({ db, lifecycle });
  try {
    assert.equal(dispatcher.availability().available, true);
    const [added, completed] = TASK_EVENT_HOOKS;
    const first = await approveAndActivate(db, lifecycle, added, projectId);
    const second = await approveAndActivate(db, lifecycle, completed, projectId);
    assert.equal(first.draft.pins.modelRef.format, 'keir-dcm/4');
    assert.equal(second.draft.pins.modelRef.format, 'keir-dcm/4');
    const selections = lifecycle.collection(owner).selections;
    assert.equal(selections[added].revision.id, first.draft.id);
    assert.equal(selections[completed].revision.id, second.draft.id);
    assert.ok(Object.values(lifecycle.collection('leo').selections).every(value => value.revision === null));

    const task = await tasks.createTask(owner, { projectId, title: 'Native source task' }, { operationId: randomUUID() });
    await dispatcher.wake();
    const creation = dispatcher.status(owner, task.id, added);
    assert.equal(creation.outcome?.classification, 'COMPLETED', JSON.stringify(creation));
    assert.equal(creation.capability, 'tasks.create');
    assert.equal(creation.observation.created.projectId, projectId);
    const createdId = creation.receipt.value.id;
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(createdId).n, 0);
    tasks.completeTask(owner, task.id);
    await dispatcher.wake();
    const completion = dispatcher.status(owner, task.id);
    assert.equal(completion.outcome?.classification, 'COMPLETED', JSON.stringify(completion));
    assert.equal(completion.receipt.effect, 'CONFIRMED');
    assert.notEqual(completion.receipt.value.id, createdId);
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 2);
    await dispatcher.dependenciesChanged();
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 2);
  } finally {
    await dispatcher.close();
    db.close();
  }
});

for (const [workflow, hookId] of [['intake', 'TaskCreated'], ['review', 'TaskCompleted'], ['follow-up', 'TaskCompleted'], ['onboarding', 'TaskCreated']]) {
  test('approved ' + workflow + ' simulation uses the same artifact on native rows', async () => {
    const db = openData(':memory:'), tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
    const lifecycle = createLifecycle(db, { compiler: createCompiler() });
    const dispatcher = createTaskDispatcher({ db, lifecycle });
    const destinationProjectId = tasks.createProject(owner, { name: 'Reviews' }).id;
    const title = 'Quote for spring launch', dueAt = '2026-03-06T16:00:00.417Z';
    const result = async task => {
      if (hookId === 'TaskCompleted') tasks.completeTask(owner, task.id);
      await dispatcher.wake();
      const observed = dispatcher.status(owner, task.id, hookId);
      assert.equal(observed.outcome?.classification, 'COMPLETED', JSON.stringify(observed));
      return observed;
    };
    try {
      await approveAndActivate(db, lifecycle, hookId, projectId, workflow, { projectId, destinationProjectId, title });
      const task = await tasks.createTask(owner, { projectId, title, tags: ['client', 'review'], ...(workflow === 'review' ? { priority: 'high' } : {}) }, { operationId: randomUUID() });
      const observed = await result(task);
      assert.equal(observed.receipt.effect, 'CONFIRMED');
      const occurrence = db.prepare('SELECT created_at FROM task_events WHERE source_task_id=? AND hook_id=?').get(task.id, hookId).created_at;
      const expectedDue = new Date(Date.parse(occurrence) + 168 * 3_600_000).toISOString();
      if (workflow === 'intake') {
        assert.equal(observed.observation.updated.before.priority, 'normal');
        assert.equal(tasks.getTask(owner, task.id).priority, 'high');
        const near = await tasks.createTask(owner, { projectId, title: title.toLowerCase(), tags: ['client'] }, { operationId: randomUUID() });
        assert.equal((await result(near)).receipt, null);
        assert.equal(tasks.getTask(owner, near.id).priority, 'normal');
      } else if (workflow === 'review') {
        const created = tasks.getTask(owner, observed.receipt.value.id);
        assert.equal(created.title, 'Review');
        assert.equal(created.projectId, destinationProjectId);
        assert.deepEqual(created.tags, ['review', 'next']);
        assert.equal(created.dueAt, expectedDue);
      } else if (workflow === 'follow-up') {
        const created = tasks.getTask(owner, observed.receipt.value.id);
        assert.equal(created.title, 'Follow-up');
        assert.equal(created.projectId, destinationProjectId);
        const next = await tasks.createTask(owner, { projectId, title: 'Another completion' }, { operationId: randomUUID() });
        assert.equal((await result(next)).receipt, null);
        assert.equal(tasks.listTasks(owner, destinationProjectId).length, 1);
      } else {
        assert.equal(tasks.getTask(owner, task.id).dueAt, expectedDue);
        const already = await tasks.createTask(owner, { projectId, title: 'Has a due time', dueAt }, { operationId: randomUUID() });
        assert.equal((await result(already)).receipt, null);
        assert.equal(tasks.getTask(owner, already.id).dueAt, dueAt);
      }
    } finally {
      await dispatcher.close();
      db.close();
    }
  });
}

for (const eventCount of [1, 2]) {
  test(eventCount === 1 ? 'concurrent dispatch and exact event replay retain one native task and receipt'
    : 'distinct concurrent events may both create after the same false open-match snapshot', async () => {
    const db = openData(':memory:'), tasks = taskService(db), effects = taskEffectService(db);
    const projectId = tasks.listProjects(owner)[0].id;
    const destinationProjectId = tasks.createProject(owner, { name: 'Concurrent follow-ups' }).id;
    const lifecycle = createLifecycle(db, { compiler: createCompiler() });
    const dispatchers = [createTaskDispatcher({ db, lifecycle, clock: () => 0 }), createTaskDispatcher({ db, lifecycle, clock: () => 0 })];
    const prepare = db.prepare, snapshots = [];
    try {
      const selected = await approveAndActivate(db, lifecycle, 'TaskCompleted', projectId, 'follow-up', { destinationProjectId });
      const sources = [];
      for (let index = 0; index < eventCount; index++) sources.push(await tasks.createTask(owner, { projectId, title: 'Source ' + index }, { operationId: randomUUID() }));
      for (const task of sources) tasks.completeTask(owner, task.id);
      const events = sources.map(task => db.prepare("SELECT * FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(task.id));
      assert.equal(new Set(events.map(event => event.event_id)).size, eventCount);
      assert.equal(new Set(events.map(event => event.original_key)).size, eventCount);
      for (const event of events) assert.equal(JSON.parse(event.pins).artifactDigest, selected.draft.pins.artifactDigest);
      db.prepare = function (sql) {
        const statement = prepare.call(this, sql);
        if (!sql.startsWith('SELECT EXISTS(SELECT 1 FROM tasks')) return statement;
        return { get(...args) {
          const result = statement.get(...args);
          snapshots.push({ args, matches: result.matches,
            created: prepare.call(db, 'SELECT count(*) AS n FROM tasks WHERE project_id=?').get(destinationProjectId).n });
          return result;
        } };
      };
      // Start both invocations before awaiting either, allowing their async native reads to precede writes.
      await Promise.all(dispatchers.map(dispatcher => dispatcher.wake()));
      assert.deepEqual(snapshots, sources.map(() => ({ args: ['Follow-up', owner, destinationProjectId], matches: 0, created: 0 })));
      const saved = events.map(event => effects.status(owner, event.event_id));
      const receiptRows = () => db.prepare('SELECT * FROM task_effect_receipts ORDER BY original_key').all();
      const receipts = receiptRows();
      const created = tasks.listTasks(owner, destinationProjectId);
      assert.equal(created.length, eventCount);
      assert.equal(receipts.length, eventCount);
      assert.equal(new Set(saved.map(status => status.receipt.value.id)).size, eventCount);
      for (const status of saved) {
        assert.equal(status.state, 'FINISHED');
        assert.equal(status.outcome.classification, 'COMPLETED');
        assert.deepEqual(status.outcome.effects, [{ step: 'changed', capability: 'tasks.create', state: 'CONFIRMED' }]);
        assert.equal(tasks.getTask(owner, status.receipt.value.id).title, 'Follow-up');
        const key = effects.keyFor(owner, status.eventId);
        const invocation = { requestKey: key, event: { id: status.eventId, source: status.sourceTaskId },
          deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
        assert.equal(effects.claim(owner, status.eventId, invocation), null);
        assert.deepEqual(await effects.createTaskOnce(owner, key, { projectId: destinationProjectId, title: 'Follow-up' }, invocation), status.receipt);
      }
      for (const task of sources) tasks.completeTask(owner, task.id);
      await Promise.all(dispatchers.map(dispatcher => dispatcher.dependenciesChanged()));
      assert.deepEqual(events.map(event => effects.status(owner, event.event_id)), saved);
      assert.deepEqual(receiptRows(), receipts);
      assert.deepEqual(tasks.listTasks(owner, destinationProjectId), created);
      assert.equal(snapshots.length, eventCount, 'Settled event replay must not repeat the lookup.');
    } finally {
      db.prepare = prepare;
      await Promise.all(dispatchers.map(dispatcher => dispatcher.close()));
      db.close();
    }
  });
}

test('a native update applies all authored fields together and retains a rejection on tag overflow', async () => {
  const db = openData(':memory:'), tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const lifecycle = createLifecycle(db, { compiler: createCompiler() }), effects = taskEffectService(db);
  try {
    await approveAndActivate(db, lifecycle, 'TaskCreated', projectId, 'intake', { projectId });
    const context = task => {
      const event = db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCreated'").get(task.id).event_id;
      const key = effects.keyFor(owner, event);
      const invocation = { requestKey: key, event: { id: event, source: task.id }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
      assert.ok(effects.claim(owner, event, invocation));
      return { event, key, invocation };
    };
    const input = { addTag: ' Client ', priority: 'high', dueAt: '2026-03-06T16:00:00.417Z' };
    const first = await tasks.createTask(owner, { projectId, title: 'Native fields', tags: ['review'], notes: 'Keep this' }, { operationId: randomUUID() });
    const one = context(first), write = effects.updateTaskOnce(owner, one.key, input, one.invocation);
    assert.equal(write.effect, 'CONFIRMED');
    assert.deepEqual(effects.status(owner, one.event).observation.updated.after,
      { tags: ['review', 'client'], priority: 'high', dueAt: input.dueAt });
    assert.equal(tasks.getTask(owner, first.id).notes, 'Keep this');
    assert.deepEqual(effects.updateTaskOnce(owner, one.key, { ...input }, one.invocation), write);
    assert.equal(effects.updateTaskOnce(owner, one.key, { ...input, addTag: 'client' }, one.invocation).code, 'KEY_PAYLOAD_MISMATCH');

    const overflow = await tasks.createTask(owner, { projectId, title: 'Tag cap', tags: ['1','2','3','4','5','6','7','8'] }, { operationId: randomUUID() });
    const two = context(overflow);
    const rejected = effects.updateTaskOnce(owner, two.key, input, two.invocation);
    assert.deepEqual(rejected, { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
    assert.deepEqual(tasks.getTask(owner, overflow.id), overflow);
    assert.deepEqual(effects.status(owner, two.event).receipt, rejected);

    const interrupted = await tasks.createTask(owner, { projectId, title: 'Deadline before commit', tags: ['review'] }, { operationId: randomUUID() });
    const three = context(interrupted);
    let now = 0;
    three.invocation.deadline.clock.nowMs = () => now;
    db.function('expireUpdateDeadline', () => { now = 1000; });
    db.exec("CREATE TEMP TRIGGER expire_update AFTER INSERT ON task_effect_receipts WHEN NEW.capability_id='tasks.update' BEGIN SELECT expireUpdateDeadline(); END");
    assert.throws(() => effects.updateTaskOnce(owner, three.key, input, three.invocation), { code: 'AUTHORITY_DENIED' });
    assert.deepEqual(tasks.getTask(owner, interrupted.id), interrupted);
    assert.equal(effects.status(owner, three.event).receipt, null);
    assert.notEqual(effects.status(owner, three.event).revokedAt, null);
    db.exec('DROP TRIGGER expire_update');

    const expired = await tasks.createTask(owner, { projectId, title: 'Deadline during proof check', tags: ['review'] }, { operationId: randomUUID() });
    const duringProof = context(expired);
    now = 0;
    duringProof.invocation.deadline.clock.nowMs = () => now;
    const prepare = db.prepare;
    let approvalReads = 0;
    db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql === 'SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?') return {
        get(...args) {
          const value = statement.get(...args);
          if (++approvalReads === 2) now = 1000;
          return value;
        },
      };
      return statement;
    };
    try { assert.throws(() => effects.updateTaskOnce(owner, duringProof.key, input, duringProof.invocation), { code: 'AUTHORITY_DENIED' }); }
    finally { db.prepare = prepare; }
    assert.equal(approvalReads, 2);
    assert.deepEqual(tasks.getTask(owner, expired.id), expired);
    assert.equal(effects.status(owner, duringProof.event).receipt, null);

    const invalidTitle = await tasks.createTask(owner, { projectId, title: 'Invalid workflow title source' }, { operationId: randomUUID() });
    const four = context(invalidTitle);
    const count = tasks.listTasks(owner, projectId).length;
    assert.deepEqual(await effects.createTaskOnce(owner, four.key, { projectId, title: '\u0000review' }, four.invocation),
      { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
    assert.equal(tasks.listTasks(owner, projectId).length, count);
  } finally { db.close(); }
});

test('tagged creates preserve authored request bytes and enforce native and wire limits', async () => {
  const db = openData(':memory:'), tasks = taskService(db), projectId = tasks.listProjects(owner)[0].id;
  const destinationProjectId = tasks.createProject(owner, { name: 'Tagged review tasks' }).id;
  const lifecycle = createLifecycle(db, { compiler: createCompiler() }), effects = taskEffectService(db);
  const input = { projectId: destinationProjectId, title: 'Tagged result' };
  try {
    await approveAndActivate(db, lifecycle, 'TaskCompleted', projectId, 'review', { projectId, destinationProjectId });
    const claim = async () => {
      const task = await tasks.createTask(owner, { projectId, title: 'Tagged source', priority: 'high', tags: ['review'] }, { operationId: randomUUID() });
      tasks.completeTask(owner, task.id);
      const row = db.prepare("SELECT event_id,original_key FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(task.id);
      const key = effects.keyFor(owner, row.event_id);
      const invocation = { requestKey: key, event: { id: row.event_id, source: task.id }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
      assert.ok(effects.claim(owner, row.event_id, invocation));
      return { row, key, invocation };
    };
    const boundary = ['😀'.repeat(16), '😁'.repeat(16), '😂'.repeat(16), '😃'.repeat(15) + 'a'];
    assert.equal(Buffer.byteLength(boundary.join(',')), 256);
    const accepted = [
      [{}, []], [{ tagsText: '' }, []], [{ tagsText: '   ' }, []],
      [{ tagsText: ' É, E\u0301 , Client ' }, ['é', 'client']], [{ tagsText: boundary.join(',') }, boundary],
    ];
    for (const [metadata, expected] of accepted) {
      const { key, invocation } = await claim(), request = { ...input, ...metadata };
      const created = await effects.createTaskOnce(owner, key, request, invocation);
      assert.equal(created.effect, 'CONFIRMED');
      assert.deepEqual(tasks.getTask(owner, created.value.id).tags, expected);
      assert.deepEqual(await effects.createTaskOnce(owner, key, { ...request }, invocation), created);
      if ('tagsText' in request)
        assert.equal((await effects.createTaskOnce(owner, key, input, invocation)).code, 'KEY_PAYLOAD_MISMATCH');
    }
    for (const tagsText of [null, ',client', 'client,', 'client,,review', 'client,\u0000review', '1,2,3,4,5,6,7,8,9']) {
      const { row, key, invocation } = await claim(), before = tasks.listTasks(owner, destinationProjectId).length;
      const rejected = await effects.createTaskOnce(owner, key, { ...input, tagsText }, invocation);
      assert.deepEqual(rejected, { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
      assert.deepEqual(effects.status(owner, row.event_id).receipt, rejected);
      assert.equal(tasks.listTasks(owner, destinationProjectId).length, before);
    }
    const overflow = await claim(), before = tasks.listTasks(owner, destinationProjectId).length;
    await assert.rejects(() => effects.createTaskOnce(owner, overflow.key, { ...input, tagsText: boundary.join(',') + 'a' }, overflow.invocation),
      { code: 'INPUT_INVALID' });
    assert.equal(effects.status(owner, overflow.row.event_id).receipt, null);
    assert.equal(tasks.listTasks(owner, destinationProjectId).length, before);

    const oldVersion = await claim();
    db.prepare("INSERT INTO task_effect_receipts(owner_id,capability_id,original_key,capability_version,payload,result,effect) VALUES (?,'tasks.create',?,'1',?,?,'NONE')")
      .run(owner, oldVersion.row.original_key, Buffer.from(JSON.stringify(input)), '{"kind":"BUSINESS_REJECTION","code":"TASK_INVALID","effect":"NONE"}');
    assert.equal((await effects.createTaskOnce(owner, oldVersion.key, input, oldVersion.invocation)).code, 'KEY_PAYLOAD_MISMATCH');
    assert.equal(tasks.listTasks(owner, destinationProjectId).length, before);
  } finally { db.close(); }
});
