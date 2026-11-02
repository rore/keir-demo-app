import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createLifecycle, simulationCases } from '../src/extension-lifecycle.mjs';
import { createTaskRead } from '../src/task-read.mjs';
import { runReadSimulation } from '@keir/runtime-node/read-simulation';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHost, loadCatalog, digest } from '../src/extension-catalog.mjs';

const authorized = () => {};
const denied = () => { throw Object.assign(new Error('Session changed'), { status: 401 }); };
function setup(t, options) {
  const db = openData(':memory:'); t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, options), service: taskService(db) };
}
async function approved(lifecycle, owner = 'maya', templateId = 'attention') {
  let state = lifecycle.state(owner);
  state = lifecycle.load(owner, { templateId, draftVersion: state.draftVersion }, authorized);
  const input = { revisionId: state.draft.id, draftVersion: state.draftVersion };
  state = await lifecycle.simulate(owner, input, authorized);
  assert.equal(state.evidence.passed, true);
  state = lifecycle.approve(owner, { ...input, evidenceId: state.evidence.id }, authorized);
  return { state, input };
}

test('actual six-case evidence, separate approval/activation and named operator rollback affect only this owner', async t => {
  const { db, lifecycle, service } = setup(t);
  const baseline = lifecycle.state('maya').selection;
  assert.equal(baseline.revision.provenance, 'operator');
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.equal(lifecycle.state('sam').selection.revision, null);
  const project = service.listProjects('maya')[0];
  const task = service.listTasks('maya', project.id).find(task => task.status === 'open');
  const advice = createTaskRead({ getTask: service.getTask, lifecycle });
  const check = () => advice({ userId: 'maya', taskId: task.id, authorize: () => true });
  assert.equal((await check()).classification, 'PENDING');
  const { state, input } = await approved(lifecycle);
  const proof = lifecycle.evidence('maya', state.evidence.id);
  assert.deepEqual(proof.reports.map(item => item.id), ['open', 'completed', 'missing', 'business-denied', 'host-denied', 'transient']);
  assert.ok(proof.reports.every(item => item.report.status === 'PASS'));
  assert.equal(proof.reports[4].report.native.code, 'AUTHORITY_DENIED');
  assert.equal((await check()).classification, 'PENDING', 'Approval does not activate');
  const selected = lifecycle.activate('maya', { ...input, generation: state.selection.generation }, authorized);
  assert.equal((await check()).classification, 'NEEDS_ATTENTION');
  lifecycle.disable('maya', { generation: selected.selection.generation }, authorized);
  assert.equal((await check()).status, 'NOT_DISPLAYED');
  lifecycle.rollback('maya', { revisionId: baseline.revision.id, generation: lifecycle.state('maya').selection.generation }, authorized);
  assert.equal((await check()).classification, 'PENDING');
  assert.equal(lifecycle.state('leo').selection.generation, 1);
  assert.equal(lifecycle.state('leo').selection.revision.templateId, 'attention');
  service.completeTask('maya', task.id);
  assert.equal((await check()).classification, 'DONE');
});

test('approved evidence stays pinned when a later sample run becomes latest', async t => {
  const { db, lifecycle } = setup(t);
  assert.equal(lifecycle.state('maya').approvedEvidenceId, null);
  const loaded = lifecycle.load('maya', { templateId: 'attention', draftVersion: 0 }, authorized);
  assert.equal(loaded.approvedEvidenceId, null);
  const input = { revisionId: loaded.draft.id, draftVersion: loaded.draftVersion };
  const first = await lifecycle.simulate('maya', input, authorized);
  lifecycle.approve('maya', { ...input, evidenceId: first.evidence.id }, authorized);
  const second = await lifecycle.simulate('maya', input, authorized);
  assert.notEqual(second.evidence.id, first.evidence.id);
  assert.equal(second.approvedEvidenceId, first.evidence.id);
  assert.equal(second.evidence.id, second.evidenceHistory[0].id);
  assert.equal(lifecycle.state('maya').approvedEvidenceId, first.evidence.id);
  assert.equal(lifecycle.state('leo').approvedEvidenceId, null);
  const reapproved = lifecycle.approve('maya', { ...input, evidenceId: second.evidence.id }, authorized);
  assert.equal(reapproved.approvedEvidenceId, second.evidence.id);
  const operator = lifecycle.state('maya').selection.revision;
  assert.equal(operator.provenance, 'operator');
  db.prepare('UPDATE extension_states SET draft_id=? WHERE owner_id=?').run(operator.id, 'maya');
  assert.equal(lifecycle.state('maya').approvedEvidenceId, null);
  const replacement = lifecycle.load('maya', { templateId: 'pending', draftVersion: reapproved.draftVersion }, authorized);
  assert.equal(replacement.approvedEvidenceId, null);
  assert.throws(() => lifecycle.activate('maya', { ...input, generation: replacement.selection.generation }, authorized), { status: 409 });
});

test('both independently expected curated suites execute through the actual simulator', async t => {
  const { lifecycle } = setup(t);
  for (const template of ['pending', 'attention']) {
    const { state } = await approved(lifecycle, 'maya', template);
    const proof = lifecycle.evidence('maya', state.evidence.id);
    assert.equal(proof.reports[0].expected.code, template === 'pending' ? 'PENDING' : 'NEEDS_ATTENTION');
    assert.equal(proof.reports[0].report.consumption.code, proof.reports[0].expected.code);
    assert.equal(proof.reports.length, 6);
  }
});

test('stale draft after approval rejects old activation even with unchanged generation; never-active cannot roll back', async t => {
  const { lifecycle } = setup(t);
  const { state, input } = await approved(lifecycle);
  lifecycle.load('maya', { templateId: 'pending', draftVersion: state.draftVersion }, authorized);
  assert.throws(() => lifecycle.activate('maya', { ...input, generation: state.selection.generation }, authorized), { status: 409 });
  assert.throws(() => lifecycle.rollback('maya', { revisionId: input.revisionId, generation: state.selection.generation }, authorized), { status: 409 });
});

test('same-generation transitions admit only one; away and back invalidates a captured same-artifact read', async t => {
  const { lifecycle } = setup(t);
  const original = lifecycle.capture('maya');
  const { state, input } = await approved(lifecycle);
  lifecycle.activate('maya', { ...input, generation: state.selection.generation }, authorized);
  assert.throws(() => lifecycle.disable('maya', { generation: state.selection.generation }, authorized), { status: 409 });
  lifecycle.rollback('maya', { revisionId: original.revisionId, generation: state.selection.generation + 1 }, authorized);
  assert.equal(lifecycle.current(original), false);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const read = createTaskRead({ lifecycle, getTask: (owner, id) => new Promise(resolve => { release = () => resolve({ id, status: 'open' }); entered(); }) });
  const pending = read({ userId: 'maya', taskId: 'sample', authorize: () => true });
  await started;
  lifecycle.disable('maya', { generation: lifecycle.state('maya').selection.generation }, authorized);
  release(); assert.equal((await pending).status, 'NOT_DISPLAYED');
});

test('foreign IDs, session revocation, forged/dependency-mismatched evidence and incomplete reports fail closed', async t => {
  const { db, lifecycle } = setup(t);
  const { state, input } = await approved(lifecycle);
  assert.throws(() => lifecycle.evidence('leo', state.evidence.id), { status: 404 });
  assert.throws(() => lifecycle.approve('leo', { ...input, evidenceId: state.evidence.id }, authorized), { status: 409 });
  assert.throws(() => lifecycle.disable('maya', { generation: 1 }, denied), { status: 401 });
  const original = db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload;
  for (const alter of [p => p.reports.pop(), p => p.reports.reverse(), p => p.reports[0].report.status = 'MISMATCH', p => p.identity.fixtureVersion = 'forged']) {
    const payload = JSON.parse(original); alter(payload);
    db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run(JSON.stringify(payload), state.evidence.id);
    assert.equal(lifecycle.state('maya').approved, false);
    assert.equal(lifecycle.state('maya').approvedEvidenceId, null);
    assert.throws(() => lifecycle.activate('maya', { ...input, generation: 1 }, authorized), { status: 409 });
  }
  db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run(original, state.evidence.id);
  db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=?").run(input.revisionId);
  assert.equal(lifecycle.state('maya').approvedEvidenceId, null);
  assert.throws(() => lifecycle.activate('maya', { ...input, generation: 1 }, authorized), { status: 409 });
});

test('actual malformed/negative simulator input cannot create eligible evidence or approval', async t => {
  const { lifecycle } = setup(t, { runSimulation: (selection, fixture, bytes) => {
    const row = JSON.parse(bytes);
    if (row.id === 'open') row.expect.outcome.result.classification = 'DONE';
    return runReadSimulation(selection, fixture, Buffer.from(JSON.stringify(row)));
  } });
  let state = lifecycle.load('maya', { templateId: 'attention', draftVersion: 0 }, authorized);
  const input = { revisionId: state.draft.id, draftVersion: state.draftVersion };
  state = await lifecycle.simulate('maya', input, authorized);
  assert.equal(state.evidence.passed, false);
  assert.equal(lifecycle.evidence('maya', state.evidence.id).reports[0].report.status, 'MISMATCH');
  assert.throws(() => lifecycle.approve('maya', { ...input, evidenceId: state.evidence.id }, authorized), { status: 409 });
});

test('simulation slots are owner/global bounded with no queue and release on settlement/error; stale draft/session is not persisted', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const { db, lifecycle } = setup(t, { runSimulation: async (...args) => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return runReadSimulation(...args);
  } });
  const a = lifecycle.load('maya', { templateId: 'pending', draftVersion: 0 }, authorized);
  const input = { revisionId: a.draft.id, draftVersion: 1 };
  const pending = lifecycle.simulate('maya', input, authorized);
  await started;
  await assert.rejects(lifecycle.simulate('maya', input, authorized), { status: 429 });
  lifecycle.load('maya', { templateId: 'attention', draftVersion: 1 }, authorized);
  release(); await assert.rejects(pending, { status: 409 });
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  const current = lifecycle.state('maya');
  assert.equal((await lifecycle.simulate('maya', { revisionId: current.draft.id, draftVersion: current.draftVersion }, authorized)).evidence.passed, true);
});

test('owner history and restore metadata are bounded and historical evidence remains immutable', async t => {
  const { lifecycle } = setup(t);
  const { state } = await approved(lifecycle);
  const saved = lifecycle.evidence('maya', state.evidence.id);
  for (let n = 0; n < 25; n++) lifecycle.disable('maya', { generation: lifecycle.state('maya').selection.generation }, authorized);
  assert.equal(lifecycle.state('maya').history.length, 20);
  const page = lifecycle.history('maya');
  assert.equal(page.rows.length, 20); assert.ok(page.next);
  assert.ok(lifecycle.history('maya', page.next).rows.length > 0);
  assert.deepEqual(lifecycle.evidence('maya', state.evidence.id), saved);
  assert.ok(Buffer.byteLength(JSON.stringify(lifecycle.state('maya'))) < 262144);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 131072);
});

test('two global simulations reject a third owner without preparation; errors and revoked sessions release slots without evidence', async t => {
  const gates = [], entered = [];
  let start;
  const ready = new Promise(resolve => { start = resolve; });
  const { db, lifecycle } = setup(t, { runSimulation: async (...args) => {
    const owner = args[1].bindings.actorId;
    if (!entered.includes(owner)) {
      entered.push(owner);
      await new Promise(resolve => { gates.push(resolve); if (gates.length === 2) start(); });
    }
    return runReadSimulation(...args);
  } });
  const inputs = {};
  for (const owner of ['maya', 'leo', 'sam']) {
    const state = lifecycle.load(owner, { templateId: 'pending', draftVersion: 0 }, authorized);
    inputs[owner] = { revisionId: state.draft.id, draftVersion: 1 };
  }
  let live = true;
  const first = lifecycle.simulate('maya', inputs.maya, () => { if (!live) denied(); });
  const second = lifecycle.simulate('leo', inputs.leo, authorized);
  await ready;
  await assert.rejects(lifecycle.simulate('sam', inputs.sam, authorized), { status: 429 });
  assert.deepEqual(entered, ['maya', 'leo']);
  live = false; gates.forEach(release => release());
  await assert.rejects(first, { status: 401 });
  assert.equal((await second).evidence.passed, true);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_evidence WHERE owner_id='maya'").get().n, 0);
  const failing = createLifecycle(db, { runSimulation: async () => { throw new Error('Fixture failure'); } });
  for (let n = 0; n < 2; n++) await assert.rejects(failing.simulate('maya', inputs.maya, authorized), /Fixture failure/);
});

test('oversized simulator report is rejected before persistence, and invalid assets cannot become rollback targets', async t => {
  const { db, lifecycle } = setup(t, { runSimulation: async (...args) => ({ ...await runReadSimulation(...args), extra: 'x'.repeat(131072) }) });
  const state = lifecycle.load('maya', { templateId: 'pending', draftVersion: 0 }, authorized);
  await assert.rejects(lifecycle.simulate('maya', { revisionId: state.draft.id, draftVersion: 1 }, authorized), { status: 413 });
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  const operator = lifecycle.state('maya').selection.revision;
  db.prepare("UPDATE extension_revisions SET identity='malformed' WHERE id=?").run(operator.id);
  assert.equal(lifecycle.state('maya').selection.eligible, false);
  assert.equal(lifecycle.capture('maya'), null);
  assert.throws(() => lifecycle.rollback('maya', { revisionId: operator.id, generation: 1 }, authorized), { status: 409 });
});

test('transaction-time reauthorization rolls back a selection mutation and history atomically', t => {
  const { db, lifecycle } = setup(t);
  let checks = 0;
  assert.throws(() => lifecycle.disable('maya', { generation: 1 }, () => { if (++checks === 2) denied(); }), { status: 401 });
  assert.equal(lifecycle.state('maya').selection.generation, 1);
  assert.equal(lifecycle.state('maya').selection.revision.templateId, 'pending');
  assert.equal(db.prepare("SELECT count(*) n FROM extension_history WHERE owner_id='maya'").get().n, 1);
});

test('source names never determine authority; a third owner can select either curated rule through their own revision', async t => {
  const { lifecycle, service } = setup(t);
  const { state, input } = await approved(lifecycle, 'sam', 'attention');
  const result = lifecycle.activate('sam', { ...input, generation: state.selection.generation }, authorized);
  assert.equal(result.owner.id, 'sam');
  assert.equal(result.selection.revision.provenance, 'customer');
  assert.equal(lifecycle.state('leo').selection.revision.provenance, 'operator');
  const tasks = service.listTasks('sam', service.listProjects('sam')[0].id);
  const read = createTaskRead({ getTask: service.getTask, lifecycle });
  assert.equal((await read({ userId: 'sam', taskId: tasks.find(task => task.status === 'open').id, authorize: () => true })).classification, 'NEEDS_ATTENTION');
});

test('actual simulator rejects an overdue synchronous authorization and gives later cases fresh checked deadlines', async t => {
  let delayed = false;
  const { lifecycle } = setup(t, { runSimulation: (selection, fixture, bytes) => {
    const original = fixture.authorize;
    return runReadSimulation(selection, { ...fixture, authorize: request => {
      if (!delayed) {
        delayed = true;
        // Exercise non-preemptible synchronous work past the actual one-second host deadline.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      }
      return original(request);
    } }, bytes);
  } });
  let state = lifecycle.load('maya', { templateId: 'attention', draftVersion: 0 }, authorized);
  const input = { revisionId: state.draft.id, draftVersion: state.draftVersion };
  state = await lifecycle.simulate('maya', input, authorized);
  const evidence = lifecycle.evidence('maya', state.evidence.id);
  assert.deepEqual(evidence.reports[0].report.native, { classification: 'LIMIT_EXCEEDED', code: 'BUDGET_EXCEEDED' });
  assert.equal(state.evidence.passed, false);
  assert.throws(() => lifecycle.approve('maya', { ...input, evidenceId: evidence.id }, authorized), { status: 409 });
  assert.ok(evidence.reports.slice(1).every(item => item.report.status === 'PASS'), 'Each later case gets a fresh deadline');
  state = await lifecycle.simulate('maya', input, authorized);
  assert.equal(state.evidence.passed, true, 'The slot is released after actual settlement');
});

const authoredSource = (steps = ['readTask']) => JSON.stringify({ language: 'keir/v0',
  domain: { id: 'demo.tasks', version: '1', fingerprint: loadHost().pins.modelDigest }, entrypoint: 'ClassifyTask', name: 'authored-third',
  steps: steps.length ? steps.map(id => ({ id, call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } }))
    : [{ id: 'constant', let: { cel: 'true' } }],
  return: { record: { classification: { cel: steps.length ? `${steps.at(-1)}.status == "COMPLETED" ? "PENDING" : "DONE"` : 'constant ? "DONE" : "PENDING"' } } } });
const authoredCase = (id, status, code, steps = ['readTask']) => JSON.stringify({ format: 'keir-read-simulation/1', id, input: { taskId: 'sample-task' },
  stubs: steps.map(step => ({ step, capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' },
    response: { kind: 'SUCCESS', value: { id: 'sample-task', status } } })),
  expect: { calls: steps.map(step => ({ step, capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' } })),
    outcome: { classification: 'COMPLETED', result: { classification: code } }, consumption: { status: 'DISPLAYED', code } } });
const currentInput = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });

test('real third-source compilation, independent suite edits and exact A/B approval/use survive restart', async t => {
  const { createCompiler } = await import('../src/compiler.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'keir-authored-'));
  let db = openData(join(directory, 'app.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true }); });
  let lifecycle = createLifecycle(db, { compiler: createCompiler({ modelBytes: loadHost().dcmBytes }) });
  const leo = lifecycle.state('leo'), nativeRows = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const duplicateSource = authoredSource().replace('"language":"keir/v0"', '"language":"keir/v0","language":"keir/v0"');
  await assert.rejects(lifecycle.compile('maya', { source: duplicateSource, draftVersion: 0 }, authorized), { status: 422 });
  assert.equal(lifecycle.state('maya').draftVersion, 0);
  let state = await lifecycle.compile('maya', { source: authoredSource(), label: 'Different task advice', draftVersion: 0 }, authorized);
  assert.equal(state.draft.suiteDigest, null);
  assert.equal(state.draft.pins.rawSourceDigest, digest(Buffer.from(authoredSource())));
  assert.notEqual(state.draft.pins.rawSourceDigest, state.draft.pins.compiledSourceDigest);
  const sourceId = state.draft.id;
  await assert.rejects(lifecycle.simulate('maya', currentInput(state), authorized), { status: 409 });
  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [authoredCase('open', 'OPEN', 'PENDING')] }, authorized);
  assert.notEqual(state.draft.id, sourceId);
  state = await lifecycle.simulate('maya', currentInput(state), authorized);
  assert.equal(state.evidence.passed, false, 'Actual newly compiled behavior mismatches the independently wrong expectation');
  assert.throws(() => lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized), { status: 409 });
  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [authoredCase('open', 'OPEN', 'DONE')] }, authorized);
  state = await lifecycle.simulate('maya', currentInput(state), authorized);
  assert.equal(state.evidence.passed, true);
  const a = state.draft, ea = state.evidence.id;
  state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: ea }, authorized);
  assert.equal(state.selection.revision.templateId, 'pending');
  state = lifecycle.activate('maya', { ...currentInput(state), generation: state.selection.generation }, authorized);
  while (state.selection.generation < 7) state = lifecycle.rollback('maya', { revisionId: a.id, generation: state.selection.generation }, authorized);
  assert.equal(state.selection.generation, 7);
  const task = taskService(db).listTasks('maya', taskService(db).listProjects('maya')[0].id).find(row => row.status === 'open');
  assert.equal((await createTaskRead({ getTask: taskService(db).getTask, lifecycle })({ userId: 'maya', taskId: task.id, authorize: () => true })).classification, 'DONE');

  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [authoredCase('open', 'OPEN', 'DONE'), authoredCase('completed', 'COMPLETED', 'PENDING')] }, authorized);
  const b = state.draft;
  assert.notEqual(b.id, a.id); assert.equal(b.pins.artifactDigest, a.pins.artifactDigest); assert.notEqual(b.suiteDigest, a.suiteDigest);
  assert.equal(state.approved, false); assert.equal(state.approvedEvidenceId, null);
  assert.equal(state.selection.revision.id, a.id); assert.equal(state.selection.eligible, true); assert.equal(state.selection.generation, 7);
  assert.throws(() => lifecycle.approve('maya', { ...currentInput(state), evidenceId: ea }, authorized), { status: 409 });
  state = await lifecycle.simulate('maya', currentInput(state), authorized);
  const eb = state.evidence.id;
  state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: eb }, authorized);
  assert.equal(state.selection.revision.id, a.id); assert.equal(state.selection.generation, 7);
  db.close(); db = openData(join(directory, 'app.sqlite')); lifecycle = createLifecycle(db);
  state = lifecycle.state('maya');
  assert.equal(state.draft.id, b.id); assert.equal(state.approvedEvidenceId, eb); assert.equal(state.selection.revision.id, a.id);
  assert.equal(lifecycle.evidence('maya', ea).passed, true);
  state = lifecycle.activate('maya', { ...currentInput(state), generation: 7 }, authorized);
  assert.equal(state.selection.generation, 8); assert.equal(state.selection.revision.id, b.id);
  assert.ok(state.restoreTargets.some(row => row.id === a.id));
  state = lifecycle.rollback('maya', { revisionId: a.id, generation: 8 }, authorized);
  assert.equal(state.selection.revision.id, a.id);
  assert.deepEqual(lifecycle.state('leo'), leo);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), nativeRows);
});

test('actual compiled zero-call and renamed repeated-read programs use exact bindings and ordered independent cases', async t => {
  const { createCompiler } = await import('../src/compiler.mjs');
  const { db, service } = setup(t);
  const lifecycle = createLifecycle(db, { compiler: createCompiler({ modelBytes: loadHost().dcmBytes }) });
  for (const steps of [[], ['firstTask', 'secondTask']]) {
    let state = lifecycle.state('maya');
    state = await lifecycle.compile('maya', { source: authoredSource(steps), draftVersion: state.draftVersion }, authorized);
    state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [authoredCase('normal', 'OPEN', 'DONE', steps)] }, authorized);
    state = await lifecycle.simulate('maya', currentInput(state), authorized);
    assert.equal(state.evidence.passed, true, `${steps.length} calls pass the actual simulator`);
    state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized);
    state = lifecycle.activate('maya', { ...currentInput(state), generation: state.selection.generation }, authorized);
    let calls = 0;
    const read = createTaskRead({ lifecycle, getTask: (...args) => { calls++; return service.getTask(...args); } });
    const task = service.listTasks('maya', service.listProjects('maya')[0].id).find(row => row.status === 'open');
    assert.equal((await read({ userId: 'maya', taskId: task.id, authorize: () => true })).classification, 'DONE');
    assert.equal(calls, steps.length);
    const proof = lifecycle.evidence('maya', state.evidence.id);
    const item = lifecycle.capture('maya').template;
    const denied = await runReadSimulation({ dcmBytes: item.dcmBytes, artifactBytes: item.artifactBytes, modelDigest: item.pins.modelDigest,
      artifactDigest: item.pins.artifactDigest, compiler: item.pins.compiler, entrypoint: 'ClassifyTask', consumer: { id: 'demo.taskadvice', version: '1', kind: 'DISPLAY' } },
      { scope: 'demo.task-advice:maya', bindings: steps.length ? { actorId: 'maya' } : {}, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 },
        authorize: () => false, consume: () => ({ status: 'NOT_DISPLAYED' }), allowedReceipts: [{ status: 'NOT_DISPLAYED' }] },
      Buffer.from(JSON.stringify({ format: 'keir-read-simulation/1', id: 'entryDenied', input: { taskId: task.id }, stubs: [],
        expect: { calls: [], outcome: { classification: 'FAILED', error: { code: 'AUTHORITY_DENIED', path: '' } }, consumption: { status: 'NOT_DISPLAYED' } } })));
    assert.equal(denied.status, 'PASS');
    assert.equal(proof.passed, true);
    if (steps.length) {
      const firstCall = { step: steps[0], capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' } };
      const rejectedCase = JSON.stringify({ format: 'keir-read-simulation/1', id: 'normalMissing', input: { taskId: 'sample-task' },
        stubs: [{ ...firstCall, response: { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' } }],
        expect: { calls: [firstCall], outcome: { classification: 'BUSINESS_REJECTION', error: { code: 'TASK_NOT_FOUND', path: '/steps/0' } }, consumption: { status: 'NOT_DISPLAYED' } } });
      state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [rejectedCase] }, authorized);
      state = await lifecycle.simulate('maya', currentInput(state), authorized);
      assert.equal(state.evidence.passed, true, 'Intended business rejection under permitted entry needs no forced success case');
      assert.equal(lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized).approved, true);
    }
  }
});

test('authored quota/tamper checks retain snapshots and LRU eviction cannot revoke an unchanged in-flight selection', async t => {
  const artifact = loadCatalog().find(row => row.id === 'attention').artifactBytes;
  const { db, service } = setup(t);
  const lifecycle = createLifecycle(db, { compiler: { compile: async () => ({ artifact, diagnostics: [] }) } });
  async function choose(owner) {
    let state = lifecycle.state(owner);
    if (state.draft?.kind !== 'authored') state = await lifecycle.compile(owner, { source: 'API fixture, not compiler qualification', draftVersion: state.draftVersion }, authorized);
    state = await lifecycle.proposeScenarios(owner, { ...currentInput(state), cases: [simulationCases('attention')[0].bytes.toString()] }, authorized);
    state = await lifecycle.simulate(owner, currentInput(state), authorized);
    state = lifecycle.approve(owner, { ...currentInput(state), evidenceId: state.evidence.id }, authorized);
    return lifecycle.activate(owner, { ...currentInput(state), generation: state.selection.generation }, authorized);
  }
  await choose('maya');
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const read = createTaskRead({ lifecycle, clock: { nowMs: () => 0 }, getTask: async (owner, id) => {
    if (owner === 'maya') { entered(); await new Promise(resolve => { release = resolve; }); }
    return { id, status: 'open' };
  } });
  const pending = read({ userId: 'maya', taskId: 'held-task', authorize: () => true });
  await reached;
  for (let n = 0; n < 17; n++) { await choose('leo'); assert.equal((await read({ userId: 'leo', taskId: 'other-task', authorize: () => true })).classification, 'NEEDS_ATTENTION'); }
  release(); assert.equal((await pending).classification, 'NEEDS_ATTENTION');
  const state = lifecycle.state('maya'), saved = db.prepare('SELECT * FROM extension_authored WHERE revision_id=?').get(state.draft.id);
  for (const field of ['source', 'artifact', 'suite']) {
    db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(field === 'suite' ? '[]' : Buffer.from('changed'), state.draft.id);
    assert.equal(lifecycle.state('maya').selection.eligible, false);
    db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(saved[field], state.draft.id);
  }
  while (db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='leo'").get().n < 32) await choose('leo');
  const before = lifecycle.state('leo');
  await assert.rejects(lifecycle.compile('leo', { source: 'quota', draftVersion: before.draftVersion }, authorized), { status: 409 });
  assert.equal(lifecycle.state('leo').selection.revision.id, before.selection.revision.id);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='leo'").get().n, 32);
  assert.ok(service.listProjects('maya').length);
});
