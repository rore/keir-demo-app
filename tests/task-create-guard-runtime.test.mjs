import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openData, taskService, taskEffectService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadHost, definitionForPins } from '../src/extension-catalog.mjs';
import { createTaskCreateGuard } from '../src/task-create-guard.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { createApp } from '../src/app.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { seedTaskEffectBinding, invocationFor } from './fixtures/task-effect-schema.mjs';

const owner = 'maya', dueAt = '2027-03-06T16:00:00.417Z', matchTitle = 'Unique follow-up';
const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });

function setup(t, disk = false) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'guard-runtime-')) : null;
  const path = directory ? join(directory, 'app.sqlite') : ':memory:';
  const db = openData(path), lifecycle = createLifecycle(db, { compiler });
  const native = taskService(db), projectId = native.listProjects(owner)[0].id;
  const otherProjectId = native.createProject(owner, { name: 'Other authorized project' }).id;
  const realGuard = createTaskCreateGuard({ db, lifecycle, commitReserveMs: 100 });
  const closers = [() => realGuard.close()];
  const f = { db, lifecycle, native, projectId, otherProjectId, path, realGuard, closers, afterCheck: async () => {} };
  f.guard = { commitReserveMs: realGuard.commitReserveMs,
    check: async context => { f.lastContext = context; const decision = await realGuard.check(context); await f.afterCheck(context, decision); return decision; },
    current: (...args) => realGuard.current(...args) };
  f.tasks = taskService(db, { guard: f.guard });
  f.counts = () => ['tasks', 'task_events', 'task_create_operations', 'task_effect_receipts'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  f.create = (input = {}, context = {}) => f.tasks.createTask(owner, { projectId, title: 'Runtime candidate', ...input }, { operationId: randomUUID(), ...context });
  t.after(async () => {
    try { for (const close of closers.reverse()) await close(); }
    finally { db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
  return f;
}

async function activate(f, fixture) {
  const { extensionId } = admitTaskDraft(f.db, f.lifecycle, { owner, name: 'Runtime guard' });
  let state = await f.lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', draftVersion: 0, source: fixture.source }, () => {});
  const artifact = JSON.parse(f.lifecycle.execution(owner, state.draft.id, extensionId).artifactBytes);
  assert.equal(artifact.format, 'keir-artifact/3');
  assert.equal(artifact.compiler, 'keir-compiler-java/0.4.0');
  const input = value => ({ extensionId, revisionId: value.draft.id, draftVersion: value.draftVersion });
  state = await f.lifecycle.proposeScenarios(owner, { ...input(state), cases: fixture.cases }, () => {});
  state = await f.lifecycle.simulate(owner, input(state), () => {});
  assert.equal(state.evidence?.passed, true, JSON.stringify(state.evidence));
  const evidenceId = state.evidence.id;
  assert.ok(f.lifecycle.evidence(owner, evidenceId, extensionId).reports.every(item => item.report.status === 'PASS'));
  state = f.lifecycle.approve(owner, { ...input(state), evidenceId }, () => {});
  state = f.lifecycle.activate(owner, { ...input(state), evidenceId, generation: state.selection.generation }, () => {});
  assert.equal(state.selection.revision.id, state.draft.id);
  return { extensionId, revisionId: state.draft.id, evidenceId, state };
}

const ordinaryFixture = (f, rule) => taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule,
  projectId: f.projectId, otherProjectId: f.otherProjectId });

async function created(f, input, context) {
  const before = f.counts(), task = await f.create(input, context);
  assert.deepEqual(f.counts(), [before[0] + 1, before[1] + 1, before[2] + 1, before[3]]);
  assert.deepEqual(f.tasks.getTask(owner, task.id), task);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=? AND hook_id=\'TaskCreated\'').get(task.id).n, 1);
  return task;
}

async function rejected(f, input, code, context = {}) {
  const before = f.counts(), operationId = context.operationId ?? randomUUID();
  await assert.rejects(() => f.create(input, { ...context, operationId }), error =>
    error.state === 'NOT_CREATED' && error.operationId === operationId && error.code === code);
  const result = f.tasks.getCreateOperation(owner, operationId);
  assert.equal(result.state, 'NOT_CREATED'); assert.equal(result.code, code);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1, before[3]]);
  return result;
}

for (const rule of ['client-due', 'priority-note', 'project-review']) {
  test(`real approved ${rule} guard allows, denies, ignores nonmatches and blocks invalid proof`, async t => {
    const f = setup(t), fixture = ordinaryFixture(f, rule), active = await activate(f, fixture);
    const inputs = {
      'client-due': [{ tags: [' Client ', 'client'], dueAt }, { tags: ['client'] }, { tags: ['internal'] }],
      'priority-note': [{ priority: 'high', notes: 'A native note' }, { priority: 'high', notes: ' \t\n ' }, { priority: 'low' }],
      'project-review': [{ tags: [' Review '] }, {}, { projectId: f.otherProjectId }],
    }[rule];
    await t.test('matching ALLOW', () => created(f, inputs[0]));
    await t.test('matching DENY', async () => {
      const result = await rejected(f, inputs[1], 'RULE_DENIED');
      assert.equal(result.message, fixture.metadata.message);
    });
    await t.test('nonmatching ALLOW', () => created(f, inputs[2]));
    await t.test('unavailable approved proof blocks an otherwise allowed candidate', async () => {
      f.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(active.evidenceId);
      await rejected(f, inputs[0], 'CHECK_UNAVAILABLE');
    });
  });
}

test('real input-only guard keeps native notes, tag and date limits and rejects forged human provenance', async t => {
  const f = setup(t); await activate(f, ordinaryFixture(f, 'priority-note'));
  const long = 'é'.repeat(4000), tags = Array.from({ length: 8 }, (_, index) => 'é'.repeat(31) + index);
  assert.ok(Buffer.byteLength(tags.join(',')) > 256);
  const task = await created(f, { notes: long, priority: 'high', tags, dueAt });
  assert.equal(task.notes, long); assert.deepEqual(task.tags, tags); assert.equal(task.dueAt, dueAt);
  await rejected(f, { priority: 'high', notes: '' }, 'RULE_DENIED');
  await rejected(f, { priority: 'high', notes: '  \t\n  ' }, 'RULE_DENIED');
  await created(f, { tags: [' Client ', 'client', ' Review '], priority: 'high', notes: 'Has a note' });
  for (const invalid of [{ notes: long + 'x' }, { dueAt: 'tomorrow' }, { tags: [...tags, 'extra'] }]) {
    const before = f.counts(); await assert.rejects(() => f.create(invalid), { status: 400 }); assert.deepEqual(f.counts(), before);
  }
  const before = f.counts();
  await assert.rejects(() => f.create({}, { requestKey: Object.freeze({ type: 'demo.TaskWorkflowKey/1', value: randomUUID() }) }), { status: 400 });
  await assert.rejects(() => f.tasks.createTask(undefined, { projectId: f.projectId, title: 'Missing actor' }, { operationId: randomUUID() }), { status: 401 });
  await assert.rejects(() => f.create({ projectId: f.native.listProjects('leo')[0].id }), { status: 404 });
  assert.equal(f.realGuard.current(Object.freeze({ status: 'ALLOWED' })), false);
  assert.equal(f.realGuard.current(Object.freeze({ status: 'ALLOWED' }), 'AFTER_WRITE'), false);
  assert.deepEqual(f.counts(), before);
});

test('the HTTP route uses the real approved guard and exposes only confirmed native results', async t => {
  const f = setup(t); await activate(f, ordinaryFixture(f, 'client-due'));
  const directory = mkdtempSync(join(tmpdir(), 'guard-runtime-http-'));
  f.closers.push(() => rmSync(directory, { recursive: true, force: true }));
  const origin = 'http://127.0.0.1:32145';
  const app = await createApp({ db: f.db, origin, staticRoot: directory, compiler, guard: f.guard });
  f.closers.push(() => app.close());
  const bootstrap = await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:32145' } });
  const login = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:32145', origin,
    'content-type': 'application/json', 'x-session-context': bootstrap.json().contextToken }, payload: { userId: owner } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { host: '127.0.0.1:32145', origin, 'content-type': 'application/json',
    cookie: 'keir_demo_session=' + login.cookies.find(cookie => cookie.name === 'keir_demo_session').value,
    'x-session-context': login.json().contextToken };
  const before = f.counts(), rejectedId = randomUUID();
  const denial = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'x-task-create-id': rejectedId },
    payload: { projectId: f.projectId, title: 'HTTP rejected', tags: ['client'] } });
  assert.equal(denial.statusCode, 422, denial.body); assert.equal(denial.json().code, 'RULE_DENIED');
  assert.equal(denial.json().operationId, rejectedId);
  assert.deepEqual(f.counts(), [before[0], before[1], before[2] + 1, before[3]]);
  const operationId = randomUUID();
  const success = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'x-task-create-id': operationId },
    payload: { projectId: f.projectId, title: 'HTTP allowed', tags: ['client'], dueAt } });
  assert.equal(success.statusCode, 201, success.body);
  const readback = await app.inject({ method: 'GET', url: '/api/task-create-operations/' + operationId, headers });
  assert.deepEqual(readback.json(), { operationId, state: 'CREATED', task: success.json() });
  assert.deepEqual(f.counts(), [before[0] + 1, before[1] + 1, before[2] + 2, before[3]]);
});

function readFixture(f) {
  const host = loadHost('TaskBeforeCreate'), model = JSON.parse(host.dcmBytes);
  const anchor = f.native.listTasks(owner, f.projectId).find(task => task.status === 'open');
  const value = { id: anchor.id, projectId: anchor.projectId, status: 'OPEN', title: anchor.title, tags: anchor.tags,
    priority: anchor.priority, ...(anchor.dueAt === null ? {} : { dueAt: anchor.dueAt }) };
  const source = JSON.stringify({ language: 'keir/2', name: 'native-read-consistency-guard', entrypoint: 'TaskBeforeCreate',
    domain: { ...model.domain, fingerprint: host.pins.modelDigest }, steps: [
      { id: 'anchorId', let: { literal: anchor.id, type: 'TaskId' } },
      { id: 'anchor', call: 'tasks.get', args: { taskId: { cel: 'anchorId' } } },
      { id: 'match', call: 'tasks.openMatch', args: { projectId: { cel: 'input.projectId' }, title: { literal: matchTitle } } },
    ], return: { record: { decision: { cel: 'match.matches ? "DENY" : "ALLOW"' },
      message: { cel: 'match.matches ? "An open match already exists." : ""' } } } });
  const input = { projectId: f.projectId, priority: 'normal', tags: [], hasNotes: false, hasDueDate: false };
  const call = (step, capability, args) => ({ step, capability, version: model.capabilities[capability].version, args, protectedArgs: { actorId: 'user1' } });
  const calls = [call('anchor', 'tasks.get', { taskId: anchor.id }), call('match', 'tasks.openMatch', { projectId: f.projectId, title: matchTitle })];
  const cases = [false, true].map(matches => {
    const result = { decision: matches ? 'DENY' : 'ALLOW', message: matches ? 'An open match already exists.' : '' };
    const events = [{ event: 'INVOCATION_START' }, { event: 'STEP_START', step: 'anchorId' }, { event: 'VALUE_BOUND', step: 'anchorId' },
      ...calls.flatMap(item => [{ event: 'STEP_START', step: item.step }, { event: 'CALL_DISPATCHED', step: item.step, capability: item.capability },
        { event: 'CALL_SUCCEEDED', step: item.step, capability: item.capability }]), { event: 'RETURNED' }, { event: 'TERMINATED' }];
    return JSON.stringify({ format: 'keir-scenario/3', id: matches ? 'existing-match' : 'absent-match', given: { input, fixture: 'normal' },
      stubs: calls.map((item, index) => ({ ...item, response: { kind: 'SUCCESS', value: index ? { matches } : value } })),
      expect: { outcome: { classification: 'COMPLETED', result, effects: [], trace: events.map((event, sequence) => ({ sequence, ...event })) },
        calls, consumption: { status: matches ? 'DENIED' : 'ALLOWED', result } } });
  });
  return { source, cases, anchor };
}

test('real READ guards allow their own insert but block independent changes before native commit', async t => {
  const f = setup(t, true), fixture = readFixture(f); await activate(f, fixture);
  await t.test('false open-match permits its own insert once', async () => {
    const task = await created(f, { title: matchTitle });
    assert.equal(task.title, matchTitle);
    await rejected(f, { title: matchTitle }, 'RULE_DENIED');
  });
  await t.test('a separate connection changes false to true before the pending native write', async () => {
    const otherDb = openData(f.path), otherLifecycle = createLifecycle(otherDb, { compiler });
    const otherGuard = createTaskCreateGuard({ db: otherDb, lifecycle: otherLifecycle, commitReserveMs: 100 });
    try {
      const other = taskService(otherDb, { guard: otherGuard }), projectId = f.native.createProject(owner, { name: 'Concurrent negative predicate' }).id;
      const deadline = { clock: { nowMs: () => 0 }, expiresAtMs: 1000 };
      const before = f.counts(); let calls = 0;
      f.afterCheck = async () => { calls++; await other.createTask(owner, { projectId, title: matchTitle }, { operationId: randomUUID(), deadline }); };
      const operationId = randomUUID();
      await assert.rejects(() => f.create({ projectId, title: matchTitle }, { operationId, deadline }), { code: 'CHECK_UNAVAILABLE' });
      assert.equal(calls, 1);
      assert.equal(f.tasks.getCreateOperation(owner, operationId).state, 'NOT_CREATED');
      assert.deepEqual(f.counts(), [before[0] + 1, before[1] + 1, before[2] + 2, before[3]]);
      assert.equal(f.native.listTasks(owner, projectId).filter(task => task.title === matchTitle).length, 1);
    } finally { f.afterCheck = async () => {}; await otherGuard.close(); otherDb.close(); }
  });
  await t.test('a changed tasks.get projection blocks a previously valid decision', async () => {
    const projectId = f.native.createProject(owner, { name: 'Changed read fact' }).id;
    f.afterCheck = async () => f.native.editTask(owner, fixture.anchor.id, { title: 'Changed after evaluation', notes: '' });
    try { await rejected(f, { projectId }, 'CHECK_UNAVAILABLE'); }
    finally { f.afterCheck = async () => {}; }
  });
  await t.test('concurrent automation checks retain separate contexts for the same original key', async () => {
    const binding = seedTaskEffectBinding(f.db, owner);
    f.db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
      .run(binding.revisionId, JSON.stringify(binding.pins), owner);
    const projectId = f.native.createProject(owner, { name: 'Concurrent keyed guards' }).id;
    const source = await f.create({ projectId, title: 'Concurrent source' }); f.tasks.completeTask(owner, source.id);
    const eventId = f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(source.id).event_id;
    const effects = taskEffectService(f.db, { guard: f.guard }), context = invocationFor(effects, owner, eventId);
    assert.ok(effects.claim(owner, eventId, context));
    const before = f.counts(), input = { projectId, title: matchTitle };
    const [first, second] = await Promise.all([effects.createTaskOnce(owner, context.requestKey, input, context), effects.createTaskOnce(owner, context.requestKey, input, context)]);
    assert.equal(first.effect, 'CONFIRMED'); assert.deepEqual(second, first);
    assert.strictEqual(f.lastContext.requestKey, context.requestKey);
    assert.strictEqual(f.lastContext.operationDeadline, context.deadline);
    assert.equal(f.lastContext.deadline.expiresAtMs, 900);
    assert.deepEqual(f.counts(), [before[0] + 1, before[1], before[2], before[3] + 1]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(first.value.id).n, 0);
  });
});

test('real guard permission, selection, cancellation and parent deadline changes fail closed', async t => {
  const f = setup(t); await activate(f, ordinaryFixture(f, 'priority-note'));
  await t.test('changed selection generation', async () => {
    f.afterCheck = async () => f.db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id=? AND hook_id='TaskBeforeCreate'").run(owner);
    try { await rejected(f, {}, 'STALE_ATTEMPT'); } finally { f.afterCheck = async () => {}; }
  });
  await t.test('lost project permission', async () => {
    const projectId = f.native.createProject(owner, { name: 'Lost permission' }).id, before = f.counts();
    f.afterCheck = async () => f.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
    try { await assert.rejects(() => f.create({ projectId }), { status: 404 }); assert.deepEqual(f.counts(), before); }
    finally { f.afterCheck = async () => {}; }
  });
  await t.test('cancelled after real ALLOW', async () => {
    const controller = new AbortController(); f.afterCheck = async () => controller.abort();
    try { await rejected(f, {}, 'STALE_ATTEMPT', { signal: controller.signal }); } finally { f.afterCheck = async () => {}; }
  });
  await t.test('approval lost after insertion rolls back the native task and event', async () => {
    f.db.exec("CREATE TEMP TRIGGER lose_runtime_guard_approval AFTER INSERT ON tasks BEGIN DELETE FROM extension_approvals WHERE owner_id='maya'; END");
    try { await rejected(f, {}, 'CHECK_UNAVAILABLE'); }
    finally { f.db.exec('DROP TRIGGER lose_runtime_guard_approval'); }
  });
  await t.test('child expiry is derived from the original parent and never reset', async () => {
    let now = 0; const deadline = { clock: { nowMs: () => now }, expiresAtMs: 1000 };
    f.afterCheck = async context => {
      assert.equal(context.deadline.expiresAtMs, 900); assert.strictEqual(context.operationDeadline, deadline); now = 900;
    };
    try { await rejected(f, {}, 'CHECK_UNAVAILABLE', { deadline }); } finally { f.afterCheck = async () => {}; }
  });
  for (const expires of [950, 1000]) await t.test(`native commit at parent time ${expires} uses the reserve without a new budget`, async () => {
    let now = 0; const deadline = { clock: { nowMs: () => now }, expiresAtMs: 1000 }, prepare = f.db.prepare;
    f.db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (!sql.startsWith('INSERT INTO tasks(')) return statement;
      return { run(...args) { now = expires; return statement.run(...args); } };
    };
    try { if (expires === 950) await created(f, {}, { deadline }); else await rejected(f, {}, 'STALE_ATTEMPT', { deadline }); }
    finally { f.db.prepare = prepare; }
  });
});

test('original approved /2 event bytes coexist with a real /3 guard under runtime 0.3', async t => {
  const f = setup(t), old = seedTaskEffectBinding(f.db, owner);
  f.db.prepare("UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(old.revisionId, JSON.stringify(old.pins), owner);
  const oldRows = () => ({ revision: f.db.prepare('SELECT * FROM extension_revisions WHERE id=?').get(old.revisionId),
    authored: f.db.prepare('SELECT * FROM extension_authored WHERE revision_id=?').get(old.revisionId),
    proof: f.db.prepare('SELECT * FROM extension_evidence WHERE id=?').get(old.pins.approvedEvidenceId),
    approval: f.db.prepare('SELECT * FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, old.revisionId) });
  const original = oldRows(), modelBytes = Buffer.from(definitionForPins(old.pins).dcmBytes);
  assert.equal(JSON.parse(Buffer.from(original.authored.artifact)).format, 'keir-artifact/2');
  assert.equal(JSON.parse(Buffer.from(original.authored.artifact)).compiler, 'keir-compiler-java/0.2.0');
  assert.deepEqual(Buffer.from(original.authored.artifact), readFileSync(new URL('./fixtures/current-task-workflow-artifact.json', import.meta.url)));
  const oldProjectId = JSON.parse(Buffer.from(original.authored.artifact)).steps.find(step => step.id === 'eligibleProject').value.literal;
  const now = new Date().toISOString();
  f.db.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(oldProjectId, owner, 'Original event fixture project', now, now);
  const active = await activate(f, ordinaryFixture(f, 'client-due'));
  const dispatcher = createTaskDispatcher({ db: f.db, lifecycle: f.lifecycle, guard: f.guard }); f.closers.push(() => dispatcher.close());
  assert.equal(dispatcher.availability().available, true);
  const source = await f.create({ projectId: oldProjectId, title: 'Old event with new guard' }); f.tasks.completeTask(owner, source.id);
  const before = f.counts(); await dispatcher.wake();
  const status = dispatcher.status(owner, source.id);
  assert.equal(status.outcome?.classification, 'COMPLETED', JSON.stringify(status)); assert.equal(status.receipt?.effect, 'CONFIRMED');
  assert.deepEqual(f.counts(), [before[0] + 1, before[1], before[2], before[3] + 1]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(status.receipt.value.id).n, 0);
  const effects = taskEffectService(f.db, { guard: f.guard }), context = invocationFor(effects, owner, status.eventId ??
    f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(source.id).event_id);
  const receipt = f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, context.requestKey.value);
  assert.equal(f.lastContext.requestKey.value, receipt.original_key);
  assert.equal(f.lastContext.deadline.expiresAtMs, f.lastContext.operationDeadline.expiresAtMs - 100);
  const payload = JSON.parse(Buffer.from(receipt.payload));
  f.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(active.evidenceId);
  assert.deepEqual(await effects.createTaskOnce(owner, context.requestKey, payload, context), status.receipt);
  assert.deepEqual(f.db.prepare('SELECT * FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, context.requestKey.value), receipt);
  assert.deepEqual(oldRows(), original);
  assert.deepEqual(Buffer.from(definitionForPins(old.pins).dcmBytes), modelBytes);
  f.db.prepare('UPDATE extension_evidence SET passed=1 WHERE id=?').run(active.evidenceId);
  const invalid = await f.create({ title: 'Invalid automation notes source' }); f.tasks.completeTask(owner, invalid.id);
  const eventId = f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(invalid.id).event_id;
  const invalidContext = invocationFor(effects, owner, eventId); assert.ok(effects.claim(owner, eventId, invalidContext));
  const counts = f.counts();
  assert.deepEqual(await effects.createTaskOnce(owner, invalidContext.requestKey, { projectId: f.projectId, title: 'Must reject null notes', notes: null }, invalidContext),
    { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
  assert.deepEqual(f.counts(), [counts[0], counts[1], counts[2], counts[3] + 1]);
  const deniedSource = await f.create({ title: 'Real automation denial source' }); f.tasks.completeTask(owner, deniedSource.id);
  const deniedEvent = f.db.prepare("SELECT event_id FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(deniedSource.id).event_id;
  const deniedContext = invocationFor(effects, owner, deniedEvent); assert.ok(effects.claim(owner, deniedEvent, deniedContext));
  const prior = f.counts();
  assert.deepEqual(await effects.createTaskOnce(owner, deniedContext.requestKey, { projectId: f.projectId, title: 'Client without due date', tagsText: 'client' }, deniedContext),
    { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' });
  assert.equal(JSON.parse(f.db.prepare('SELECT guard_details FROM task_effect_receipts WHERE owner_id=? AND original_key=?').get(owner, deniedContext.requestKey.value).guard_details).code, 'TASK_CREATE_DENIED');
  assert.deepEqual(f.counts(), [prior[0], prior[1], prior[2], prior[3] + 1]);
});
