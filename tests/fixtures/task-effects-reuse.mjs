import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { openData, taskService } from '../../src/data.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { digest, TASK_HOOK } from '../../src/extension-catalog.mjs';
import { taskCustomizationFixture } from './task-customization.mjs';
import { admitTaskDraft } from './task-authoring.mjs';

const actual = await import('@keir/runtime-node');
const db = openData(':memory:'), native = taskService(db);
let dispatcher;
try {
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const lifecycle = createLifecycle(db, { compiler });
  const project = native.listProjects('sam')[0], other = native.listProjects('maya')[0];
  const fixture = taskCustomizationFixture({ projectId: project.id, otherProjectId: other.id, title: 'Reusable customer follow-up' });
  const selections = new Map();
  for (const owner of ['sam', 'maya']) {
    const { extensionId } = admitTaskDraft(db, lifecycle, { owner });
    let state = await lifecycle.compile(owner, { extensionId, draftVersion: 0, hookId: TASK_HOOK, source: fixture.source }, () => {});
    state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.cases }, () => {});
    const input = { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion };
    state = await lifecycle.simulate(owner, input, () => {});
    assert.equal(state.evidence.passed, true);
    state = lifecycle.approve(owner, { ...input, evidenceId: state.evidence.id }, () => {});
    state = lifecycle.activate(owner, { ...input, generation: state.selection.generation }, () => {});
    selections.set(owner, { state, input });
  }
  const sam = selections.get('sam'), maya = selections.get('maya');
  assert.equal(sam.state.draft.pins.artifactDigest, maya.state.draft.pins.artifactDigest);
  assert.equal(digest(lifecycle.execution('sam', sam.input.revisionId, sam.input.extensionId).artifactBytes), sam.state.draft.pins.artifactDigest);

  let binds = 0, prepares = 0, now = 0, beforeInvoke;
  const invocations = [];
  mock.module('@keir/runtime-node', { namedExports: { ...actual,
    bindModel(...args) { binds++; return actual.bindModel(...args); },
    prepareProgram(...args) { prepares++; return actual.prepareProgram(...args); },
    invokeProgram(...args) {
      invocations.push({ prepared: args[0], input: args[1], invocation: args[2] });
      beforeInvoke?.();
      return actual.invokeProgram(...args);
    },
  } });
  // Import only after instrumentation: all wrappers forward the actual packaged API unchanged.
  const { createTaskDispatcher } = await import('../../src/task-effects.mjs');
  dispatcher = createTaskDispatcher({ db, lifecycle, clock: () => now });
  assert.equal(dispatcher.availability().available, true);
  const complete = async (owner, projectId, title) => {
    const source = native.createTask(owner, { projectId, title });
    native.completeTask(owner, source.id);
    await dispatcher.wake();
    return { source, status: dispatcher.status(owner, source.id) };
  };
  const first = await complete('sam', project.id, 'First source');
  assert.equal(first.status.state, 'FINISHED'); assert.equal(first.status.receipt?.effect, 'CONFIRMED');
  assert.equal(native.getTask('sam', first.status.receipt.value.id).title, fixture.metadata.title);
  now = 100;
  const second = await complete('maya', other.id, 'Other owner source');
  assert.equal(second.status.state, 'FINISHED'); assert.deepEqual(second.status.outcome.result, { status: 'NO_OP' });
  assert.equal(second.status.receipt, null);
  assert.throws(() => dispatcher.status('sam', second.source.id), { status: 404 });

  now = 200;
  beforeInvoke = () => {
    beforeInvoke = undefined;
    sam.state = lifecycle.disable('sam', { extensionId: sam.input.extensionId, generation: sam.state.selection.generation }, () => {});
  };
  const revoked = await complete('sam', project.id, 'Revoked after claim');
  assert.equal(revoked.status.state, 'FINISHED'); assert.equal(revoked.status.receipt, null);
  assert.notEqual(revoked.status.outcome.classification, 'COMPLETED');
  assert.equal(revoked.status.outcome.error.code, 'ACCESS_DENIED');
  assert.deepEqual(revoked.status.outcome.trace.filter(row => row.event === 'CALL_DISPATCHED').map(row => row.capability), ['tasks.get']);
  assert.deepEqual(revoked.status.outcome.effects, [], 'The reached read implementation rejects before any native write.');
  assert.ok(db.prepare('SELECT revoked_at FROM task_completion_events WHERE source_task_id=?').get(revoked.source.id).revoked_at);

  sam.state = lifecycle.activate('sam', { ...sam.input, generation: sam.state.selection.generation }, () => {});
  now = 300;
  db.function('expireReuseDeadline', () => { now = 1301; return 0; });
  db.exec('CREATE TEMP TRIGGER expire_reused_task_effect AFTER INSERT ON task_effect_receipts BEGIN SELECT expireReuseDeadline(); END');
  const expired = await complete('sam', project.id, 'Fresh deadline expires at commit');
  assert.equal(expired.status.state, 'FINISHED'); assert.equal(expired.status.receipt, null);
  assert.equal(expired.status.outcome.effects.some(effect => effect.state === 'CONFIRMED'), false);
  assert.ok(db.prepare('SELECT revoked_at FROM task_completion_events WHERE source_task_id=?').get(expired.source.id).revoked_at);
  assert.equal(native.listTasks('sam', project.id).filter(task => task.title === fixture.metadata.title).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 1);

  assert.equal(binds, 1); assert.equal(prepares, 1); assert.equal(invocations.length, 4);
  assert.ok(invocations.every(row => row.prepared === invocations[0].prepared));
  assert.deepEqual(invocations.map(row => row.invocation.bindings.actorId), ['sam', 'maya', 'sam', 'sam']);
  assert.deepEqual(invocations.map(row => row.invocation.deadline.expiresAtMs), [1000, 1100, 1200, 1300]);
  assert.equal(new Set(invocations.map(row => row.invocation.requestKey)).size, 4);
  assert.equal(new Set(invocations.map(row => row.invocation.event.id)).size, 4);
  assert.equal(new Set(invocations.map(row => row.invocation.deadline)).size, 4);
  for (const row of invocations) {
    const event = db.prepare('SELECT original_key,source_task_id FROM task_completion_events WHERE event_id=?').get(row.invocation.event.id);
    assert.equal(row.invocation.requestKey.value, event.original_key);
    assert.equal(row.invocation.event.source, event.source_task_id);
    assert.equal(row.input.taskId, event.source_task_id);
  }
  now = 0;
  await dispatcher.dependenciesChanged();
  assert.equal(invocations.length, 4, 'Revocation and expiry cannot replay when the clock or dependencies change.');
  assert.deepEqual(dispatcher.status('sam', first.source.id), first.status, 'A later event never changes the first receipt or outcome.');
  assert.deepEqual(dispatcher.status('sam', revoked.source.id), revoked.status);
  assert.deepEqual(dispatcher.status('sam', expired.source.id), expired.status);
  process.stdout.write(JSON.stringify({ binds, prepares, invocations: invocations.length,
    outcomes: ['CONFIRMED', 'NO_OP', 'REVOKED', 'EXPIRED'] }));
} finally { await dispatcher?.close(); db.close(); }
