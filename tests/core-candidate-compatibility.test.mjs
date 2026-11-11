import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadHost, definitionForPins, admitArtifact, TASK_HOOKS } from '../src/extension-catalog.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { createTaskCreateGuard } from '../src/task-create-guard.mjs';
import { taskEffectSyntax, taskEffectScenarioExamples } from '../src/task-effect-simulation.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { restoreSavedCore030, savedRows, savedCore030 } from './fixtures/saved-core-0.3.0.mjs';

const owner = 'maya', newerOwner = 'leo';
const input = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
function setup(t) {
  const db = openData(':memory:'); restoreSavedCore030(db); t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler: createCompiler() }) };
}
async function activateNew(db, lifecycle, hookId, actor = newerOwner) {
  const host = loadHost(hookId), projectId = taskService(db).listProjects(actor)[0].id;
  const fixture = hookId === 'TaskBeforeCreate' ? taskCreateGuardFixture({ host, rule: 'client-due', projectId }) : {
    source: taskEffectSyntax(host).replaceAll('"project1"', JSON.stringify(projectId)),
    cases: taskEffectScenarioExamples(host).map(text => text.replaceAll('"project1"', JSON.stringify(projectId))),
  };
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner: actor });
  let state = await lifecycle.compile(actor, { extensionId, hookId, draftVersion: 0, source: fixture.source }, () => {});
  assert.equal(state.draft.pins.compiler, 'keir-compiler-java/0.3.1');
  state = await lifecycle.proposeScenarios(actor, { ...input(state), cases: fixture.cases }, () => {});
  state = await lifecycle.simulate(actor, input(state), () => {}); assert.equal(state.evidence.passed, true);
  const evidenceId = state.evidence.id;
  state = lifecycle.approve(actor, { ...input(state), evidenceId }, () => {});
  return lifecycle.activate(actor, { ...input(state), evidenceId, generation: state.selection.generation }, () => {});
}

test('retained 0.3.0 selections, artifacts and approvals reopen beside current 0.3.1 definitions', async t => {
  const { db, lifecycle } = setup(t), original = savedRows(db);
  assert.equal(savedCore030.demoRevision, '74778142e29048bfae0493d264a2e6e2fe7a14fd');
  for (const hook of TASK_HOOKS) {
    const id = 'compat-030-' + hook, state = lifecycle.state(owner, id);
    assert.equal(state.selection.eligible, true, hook);
    assert.equal(state.selection.revision.pins.compiler, 'keir-compiler-java/0.3.0');
    assert.equal(state.selection.revision.pins.modelDigest, loadHost(hook).pins.modelDigest);
    const execution = lifecycle.execution(owner, state.selection.revision.id, id);
    const trusted = definitionForPins(execution.pins);
    assert.equal(trusted.pins.compiler, 'keir-compiler-java/0.3.0');
    assert.equal(admitArtifact(execution.artifactBytes, trusted).compiler, trusted.pins.compiler);
    assert.throws(() => admitArtifact(execution.artifactBytes, loadHost(hook)), /Artifact compiler mismatch/);
    const current = await activateNew(db, lifecycle, hook);
    const newer = lifecycle.execution(newerOwner, current.draft.id, current.extension.id);
    assert.throws(() => admitArtifact(newer.artifactBytes, trusted), /Artifact compiler mismatch/);
  }
  const reopened = createLifecycle(db);
  for (const hook of TASK_HOOKS) assert.equal(reopened.state(owner, 'compat-030-' + hook).selection.eligible, true);
  assert.deepEqual(savedRows(db), original, 'Saved identity, source, artifact, proof, approval and selection bytes are unchanged.');
});

for (const order of [[owner, newerOwner], [newerOwner, owner]]) for (const hook of ['TaskCreated', 'TaskCompleted']) {
  test(`native ${hook} admissions preserve both producers in cache order ${order.join(',')}`, async t => {
    const { db, lifecycle } = setup(t), original = savedRows(db);
    await activateNew(db, lifecycle, hook);
    const reopened = createLifecycle(db), guard = createTaskCreateGuard({ db, lifecycle: reopened, commitReserveMs: 100 });
    const dispatcher = createTaskDispatcher({ db, lifecycle: reopened, guard });
    t.after(async () => { await dispatcher.close(); await guard.close(); });
    const tasks = taskService(db, { guard });
    for (const actor of order) {
      const projectId = actor === owner ? savedCore030.projectId : tasks.listProjects(actor)[0].id;
      const task = await tasks.createTask(actor, { projectId, title: 'Fictional source task' }, { operationId: randomUUID() });
      if (hook === 'TaskCompleted') tasks.completeTask(actor, task.id);
      await dispatcher.wake();
      const result = dispatcher.status(actor, task.id, hook);
      assert.equal(result.outcome?.classification, 'COMPLETED', JSON.stringify(result));
      assert.equal(result.receipt?.effect, 'CONFIRMED', JSON.stringify(result));
      const followUp = tasks.getTask(actor, result.receipt.value.id);
      assert.equal(followUp.title, 'Example follow-up task'); assert.equal(followUp.projectId, projectId);
      const admission = db.prepare('SELECT pins,revoked_at FROM task_events WHERE source_task_id=? AND hook_id=?').get(task.id, hook);
      assert.equal(JSON.parse(admission.pins).compiler, actor === owner ? 'keir-compiler-java/0.3.0' : 'keir-compiler-java/0.3.1');
      assert.equal(admission.revoked_at, null);
    }
    assert.deepEqual(savedRows(db), original);
  });
}

test('retained and new guards allow, deny and block native writes after reopening without identity switching', async t => {
  const { db, lifecycle } = setup(t), original = savedRows(db);
  await activateNew(db, lifecycle, 'TaskBeforeCreate');
  const reopened = createLifecycle(db), guard = createTaskCreateGuard({ db, lifecycle: reopened, commitReserveMs: 100 });
  t.after(() => guard.close());
  const tasks = taskService(db, { guard });
  const create = (actor, changes = {}) => tasks.createTask(actor, {
    projectId: tasks.listProjects(actor)[0].id, title: 'Fictional client task', tags: ['client'], dueAt: '2027-03-06T16:00:00.417Z', ...changes,
  }, { operationId: randomUUID() });
  const allowed = await Promise.all([create(owner), create(newerOwner)]);
  for (let i = 0; i < allowed.length; i++) assert.equal(tasks.getTask([owner, newerOwner][i], allowed[i].id).title, 'Fictional client task');
  await Promise.all([owner, newerOwner].map(actor => assert.rejects(() => create(actor, { dueAt: null }), error => error.code === 'RULE_DENIED' && error.state === 'NOT_CREATED')));
  assert.deepEqual(savedRows(db), original);
  const oldProof = db.prepare("SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=(SELECT revision_id FROM extension_selections WHERE owner_id=? AND hook_id='TaskBeforeCreate')").get(owner, owner).evidence_id;
  const count = () => db.prepare('SELECT count(*) n FROM tasks').get().n;
  const before = count();
  db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(oldProof);
  await assert.rejects(() => create(owner), error => error.code === 'CHECK_UNAVAILABLE' && error.state === 'NOT_CREATED');
  assert.equal(count(), before);
  const current = await create(newerOwner); assert.equal(tasks.getTask(newerOwner, current.id).title, 'Fictional client task');
  db.prepare('UPDATE extension_evidence SET passed=1 WHERE id=?').run(oldProof);
  assert.deepEqual(savedRows(db), original);
});
