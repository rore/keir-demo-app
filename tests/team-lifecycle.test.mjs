import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime, installTeamRevision } from '../src/team-runtime.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { createApp } from '../src/app.mjs';

const parameters = { reviewerId: 'leo', title: 'Review deliverable', intent: '' };
const replacement = { reviewerId: 'maya', title: 'Check the revised deliverable', intent: '' };
let compiler;
before(async () => {
  const db = openData(':memory:'), api = createTeamCapability(db), cache = new Map();
  const project = taskService(db).createProject('maya', { name: 'Compile once', mode: 'TEAM' });
  teamProjectService(db).addMember('maya', project.id, { userId: 'leo' });
  try {
    for (const [version, params] of [parameters, replacement].entries()) {
      const state = await api.propose('maya', project.id, { expectedDraftVersion: version, ...params });
      const saved = api.source('maya', project.id, state.draft.revisionId);
      for (const hook of ['TaskCreated', 'TaskBeforeComplete'])
        cache.set(saved.sourceBundle.sources[hook], Buffer.from(saved.artifacts[saved.manifest[hook]]));
    }
    compiler = { async compile(bytes) {
      assert.ok(cache.has(bytes.toString()), 'Use the exact real compiled source');
      return { artifact: cache.get(bytes.toString()), diagnostics: [] };
    } };
  } finally { await api.close(); db.close(); }
});
async function setup(t, seams, file = false) {
  const directory = file ? mkdtempSync(join(tmpdir(), 'team-lifecycle-')) : null;
  const path = directory ? join(directory, 'app.sqlite') : ':memory:';
  const db = openData(path), api = createTeamCapability(db, { compiler }, seams), teams = teamProjectService(db);
  const project = taskService(db).createProject('maya', { name: 'Lifecycle team', mode: 'TEAM' });
  teams.addMember('maya', project.id, { userId: 'leo' }); teams.addMember('maya', project.id, { userId: 'sam' });
  const f = { db, api, teams, project, path, app: null };
  t.after(async () => { await f.app?.close(); await api.close(); db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const state = await api.propose('maya', project.id, { expectedDraftVersion: 0, ...parameters });
  f.state = state;
  f.checked = await api.simulate('maya', project.id, { expectedDraftVersion: 1, revisionId: state.draft.revisionId, cases: state.examples });
  f.input = { operationId: randomUUID(), expectedDraftVersion: 1, revisionId: state.draft.revisionId,
    evidenceId: f.checked.evidenceId, cases: state.examples };
  return f;
}
const snapshot = db => ['team_selections', 'team_approvals', 'team_activations', 'team_controls']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const activation = (f, approval, overrides = {}) => ({ ...f.input, operationId: randomUUID(),
  approvalId: approval.receipt.id, expectedSelectionGeneration: f.api.state('maya', f.project.id).selection.generation, ...overrides });

test('human approval and separate activation preserve real old/new native pins without running work during either choice', async t => {
  const f = await setup(t), runtime = createTeamRuntime({ db: f.db }), tasks = taskService(f.db, { team: runtime });
  try {
    const unbound = await tasks.createTask('maya', { projectId: f.project.id, title: 'Before any selection' }, { operationId: randomUUID() });
    const before = f.db.prepare('SELECT * FROM team_admissions').all();
    assert.equal(f.api.state('maya', f.project.id).eligibility.eligible, true);
    const approval = await f.api.approve('maya', f.project.id, f.input);
    assert.equal(approval.current.revisionId, null); assert.equal(approval.current.generation, 0);
    const firstInput = activation(f, approval), first = await f.api.activate('maya', f.project.id, firstInput);
    assert.equal(first.current.generation, 1); assert.equal(first.current.activation.id, first.receipt.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions').all(), before);
    const old = await tasks.createTask('maya', { projectId: f.project.id, title: 'A work' }, { operationId: randomUUID() });
    await runtime.wake();
    const oldPin = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id);
    const next = await f.api.propose('maya', f.project.id, { expectedDraftVersion: 1, ...replacement });
    const checked = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 2, revisionId: next.draft.revisionId, cases: next.examples });
    const secondBody = { operationId: randomUUID(), expectedDraftVersion: 2, revisionId: next.draft.revisionId, evidenceId: checked.evidenceId, cases: next.examples };
    const secondApproval = await f.api.approve('maya', f.project.id, secondBody);
    assert.equal(secondApproval.current.revisionId, oldPin.revision_id);
    const second = await f.api.activate('maya', f.project.id, { ...secondBody, operationId: randomUUID(), approvalId: secondApproval.receipt.id, expectedSelectionGeneration: 1 });
    assert.equal(second.current.generation, 2);
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id), oldPin);
    const recent = await tasks.createTask('maya', { projectId: f.project.id, title: 'B work' }, { operationId: randomUUID() });
    await runtime.wake();
    const recentPin = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(recent.id);
    assert.equal(recentPin.revision_id, next.draft.revisionId);
    assert.notEqual(recentPin.manifest, oldPin.manifest);
    await assert.rejects(tasks.completeTask('maya', old.id), { status: 422 });
    assert.equal(tasks.getTask('leo', oldPin.child_id).assigneeId, 'leo');
    assert.equal(tasks.getTask('maya', recentPin.child_id).assigneeId, 'maya');
    await tasks.completeTask('leo', oldPin.child_id); await tasks.completeTask('maya', old.id);
    await tasks.completeTask('maya', recentPin.child_id); await tasks.completeTask('maya', recent.id);
    assert.equal((await tasks.completeTask('maya', unbound.id)).status, 'completed');
    assert.equal(f.db.prepare('SELECT policy_state FROM team_admissions WHERE source_task_id=?').get(unbound.id).policy_state, 'NO_POLICY');
    assert.throws(() => f.db.exec("UPDATE team_approvals SET created_at='changed'"), /immutable/);
    assert.throws(() => f.db.exec("UPDATE team_activations SET created_at='changed'"), /immutable/);
  } finally { await runtime.close(); }
});

test('newest evidence fences both choices, including a newer pass, while exact duplicate receipts remain historical', async t => {
  const f = await setup(t), approved = await f.api.approve('maya', f.project.id, f.input);
  const again = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: f.input.revisionId, cases: f.input.cases });
  await assert.rejects(f.api.approve('maya', f.project.id, { ...f.input, operationId: randomUUID() }), { status: 409 });
  await assert.rejects(f.api.activate('maya', f.project.id, activation(f, approved)), { status: 409 });
  const fresh = { ...f.input, operationId: randomUUID(), evidenceId: again.evidenceId };
  const approvedAgain = await f.api.approve('maya', f.project.id, fresh);
  const body = activation(f, approvedAgain, { evidenceId: again.evidenceId });
  const active = await f.api.activate('maya', f.project.id, body);
  const cases = structuredClone(f.input.cases); cases[0].actions[2].expect.decision = 'ALLOW';
  await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: f.input.revisionId, cases });
  assert.equal(f.api.state('maya', f.project.id).eligibility.eligible, false);
  assert.equal(f.api.state('maya', f.project.id).selection.activation.id, active.receipt.id);
  await assert.rejects(f.api.activate('maya', f.project.id, { ...body, operationId: randomUUID(), expectedSelectionGeneration: 1 }), { status: 409 });
  const replay = await f.api.activate('maya', f.project.id, body);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, active.receipt);
  assert.equal(replay.current.generation, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_activations').get().n, 1);
});

test('the six-case contract rejects altered roles, faults, actions, initial tasks and authorization BLOCKED substituted for rule DENY', async t => {
  for (const change of ['partial', 'role', 'fault', 'actions', 'initial', 'blocked']) await t.test(change, async t => {
    const f = await setup(t), cases = structuredClone(f.input.cases);
    if (change === 'partial') for (const c of cases) c.actions = [c.actions[0]];
    if (change === 'role') cases[0].actors[1].role = 'ADMIN';
    if (change === 'fault') { cases[4].fault = 'NONE'; cases[4].actions[1].expect.outcome = 'COMPLETED'; }
    if (change === 'actions') cases[0].actions.splice(2, 1);
    if (change === 'initial') cases[0].initialTasks.push({ actor: 'author', ref: 'initial', title: 'Extra initial work' });
    if (change === 'blocked') { cases[0].actions[2].actor = 'reviewer'; cases[0].actions[2].expect.decision = 'BLOCKED'; }
    const result = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: f.input.revisionId, cases });
    assert.equal(f.api.evidence('maya', f.project.id, result.evidenceId).passed, true, 'An actually passing but insufficient/altered run');
    const before = snapshot(f.db);
    await assert.rejects(f.api.approve('maya', f.project.id, { ...f.input, operationId: randomUUID(), evidenceId: result.evidenceId, cases }), { status: 409 });
    assert.deepEqual(snapshot(f.db), before);
  });
});

test('edited cases, false pass flags, missing artifacts and revoked revisions cannot be approved', async t => {
  for (const change of ['edited', 'report', 'artifact', 'revoked']) await t.test(change, async t => {
    const f = await setup(t), body = structuredClone(f.input), before = snapshot(f.db);
    if (change === 'edited') body.cases[0].actions[2].expect.decision = 'ALLOW';
    if (change === 'report') {
      const row = f.db.prepare('SELECT * FROM team_evidence WHERE id=?').get(body.evidenceId);
      body.evidenceId = randomUUID();
      f.db.prepare(`INSERT INTO team_evidence SELECT ?,project_id,revision_id,executable_identity,case_digest,harness,cases,'{}',1,created_at
        FROM team_evidence WHERE id=?`).run(body.evidenceId, row.id);
    }
    if (change === 'artifact') {
      f.db.exec('DROP TRIGGER team_revision_immutable');
      f.db.prepare("UPDATE team_revisions SET artifacts='{}' WHERE revision_id=?").run(body.revisionId);
    }
    if (change === 'revoked') f.teams.revoke('maya', f.project.id, body.revisionId);
    const afterFixture = snapshot(f.db);
    await assert.rejects(f.api.approve('maya', f.project.id, body));
    assert.deepEqual(snapshot(f.db), afterFixture);
    assert.equal(before[1].length, 0);
  });
});

test('historical approver may be demoted, but the activator and configured reviewer must be current', async t => {
  const f = await setup(t), approved = await f.api.approve('maya', f.project.id, f.input), body = activation(f, approved);
  f.db.exec("UPDATE project_members SET role='MEMBER' WHERE user_id='maya'; UPDATE project_members SET role='ADMIN' WHERE user_id='sam'");
  await assert.rejects(f.api.activate('maya', f.project.id, body), { status: 403 });
  const active = await f.api.activate('sam', f.project.id, body);
  assert.equal(active.receipt.actorId, 'sam');
  assert.equal(f.db.prepare('SELECT actor_id FROM team_approvals').get().actor_id, 'maya');
  f.db.exec("DELETE FROM project_members WHERE user_id='leo'");
  await assert.rejects(f.api.activate('sam', f.project.id, { ...body, operationId: randomUUID(), expectedSelectionGeneration: 1 }), { status: 409 });
  assert.equal(f.api.readOperation('sam', f.project.id, body.operationId).receipt.id, active.receipt.id);
});

test('one stale generation loses across connections; native ABA/no-op/revoke changes cannot inherit Studio provenance', async t => {
  const f = await setup(t, undefined, true), approved = await f.api.approve('maya', f.project.id, f.input);
  const otherDb = openData(f.path), other = createTeamCapability(otherDb, { compiler });
  try {
    const body = activation(f, approved), results = await Promise.allSettled([
      f.api.activate('maya', f.project.id, body),
      other.activate('maya', f.project.id, { ...body, operationId: randomUUID() }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.api.state('maya', f.project.id).selection.generation, 1);
    const history = f.api.readOperation('maya', f.project.id, body.operationId).receipt;
    assert.ok(history);
    f.teams.setSelection('maya', f.project.id, null);
    f.teams.setSelection('maya', f.project.id, body.revisionId);
    assert.equal(f.api.state('maya', f.project.id).selection.generation, 3);
    assert.equal(f.api.state('maya', f.project.id).selection.activation, null);
    await assert.rejects(f.api.activate('maya', f.project.id, { ...body, operationId: randomUUID() }), { status: 409 });
    const replay = await f.api.activate('maya', f.project.id, body);
    assert.deepEqual(replay.receipt, history); assert.equal(replay.current.generation, 3);
    await assert.rejects(f.api.activate('maya', f.project.id, { ...body, cases: f.input.cases.slice(0, 1) }), { status: 409 });
    f.teams.setSelection('maya', f.project.id, body.revisionId);
    assert.equal(f.api.state('maya', f.project.id).selection.generation, 4);
    f.teams.revoke('maya', f.project.id, body.revisionId);
    assert.equal(f.api.readOperation('maya', f.project.id, body.operationId).current.generation, 5);
    assert.deepEqual(f.api.readOperation('maya', f.project.id, body.operationId).receipt, history);
    f.db.exec('UPDATE team_selections SET generation=9007199254740991');
    assert.throws(() => f.teams.setSelection('maya', f.project.id, null), /CHECK/);
    assert.equal(f.db.prepare('SELECT generation FROM team_selections').get().generation, Number.MAX_SAFE_INTEGER);
  } finally { await other.close(); otherDb.close(); }
});

test('approval and activation postwrite session, role, reviewer, draft, evidence, revocation, abort and lease changes roll back', async t => {
  for (const kind of ['approvals', 'activations']) for (const change of ['session', 'role', 'reviewer', 'draft', 'evidence', 'revoked', 'abort', 'expiry', 'insert-fail']) {
    await t.test(`${kind}/${change}`, async t => {
      let actor = 'maya', time = 100;
      const f = await setup(t, { now: () => time }), abort = new AbortController();
      const approved = kind === 'activations' ? await f.api.approve('maya', f.project.id, f.input) : null;
      const body = approved ? activation(f, approved) : f.input, before = snapshot(f.db);
      f.db.function('stop_choice', () => { if (change === 'session') actor = 'leo'; if (change === 'expiry') time = 2100; if (change === 'abort') abort.abort(); return 1; });
      const sql = { role: "UPDATE project_members SET role='MEMBER' WHERE user_id='maya';",
        reviewer: "DELETE FROM project_members WHERE user_id='leo';", draft: 'UPDATE team_drafts SET draft_version=draft_version+1;',
        revoked: 'UPDATE team_revisions SET revoked_at=0;',
        evidence: `INSERT INTO team_evidence SELECT '${randomUUID()}',project_id,revision_id,executable_identity,case_digest,harness,cases,report,0,created_at FROM team_evidence LIMIT 1;`,
        'insert-fail': "SELECT RAISE(ABORT,'Choice insertion failed');" }[change] ?? 'SELECT stop_choice();';
      f.db.exec(`CREATE TEMP TRIGGER fence AFTER INSERT ON team_${kind} BEGIN ${sql} END`);
      await assert.rejects(f.api[kind === 'approvals' ? 'approve' : 'activate']('maya', f.project.id, body, () => actor, { signal: abort.signal }));
      assert.deepEqual(snapshot(f.db), before);
    });
  }
});

test('operation IDs bind exact normalized input across action kinds, survive later choices and require current actor authority', async t => {
  const f = await setup(t), first = await f.api.approve('maya', f.project.id, f.input);
  assert.deepEqual((await f.api.approve('maya', f.project.id, f.input)).receipt, first.receipt);
  await assert.rejects(f.api.approve('maya', f.project.id, { ...f.input, expectedDraftVersion: 0 }), { status: 409 });
  await assert.rejects(f.api.activate('maya', f.project.id, activation(f, first, { operationId: f.input.operationId })), { status: 409 });
  assert.throws(() => f.api.readOperation('sam', f.project.id, f.input.operationId), { status: 403 });
  f.db.exec("UPDATE project_members SET role='ADMIN' WHERE user_id='sam'");
  assert.equal(f.api.readOperation('sam', f.project.id, f.input.operationId).receipt, null);
  const activeInput = activation(f, first), saved = await f.api.activate('maya', f.project.id, activeInput);
  f.teams.setSelection('maya', f.project.id, null);
  const read = f.api.readOperation('maya', f.project.id, activeInput.operationId);
  assert.deepEqual(read.receipt, saved.receipt); assert.equal(read.current.revisionId, null);
  f.db.exec("UPDATE project_members SET role='MEMBER' WHERE user_id='maya'");
  assert.throws(() => f.api.readOperation('maya', f.project.id, activeInput.operationId), { status: 403 });
});

test('ordinary HTTP choices/readback reject members, foreign records, forged fields and stale sessions', async t => {
  const f = await setup(t), origin = 'http://127.0.0.1:32349';
  const app = await createApp({ db: f.db, origin, staticRoot: fileURLToPath(new URL('../dist/', import.meta.url)) }); f.app = app;
  const call = (auth, method, url, payload) => app.inject({ method, url, headers: { host: '127.0.0.1:32349', origin, 'content-type': 'application/json', ...auth },
    ...(payload === undefined ? {} : { payload }) });
  async function login(userId) {
    const bootstrap = (await call({}, 'GET', '/api/session')).json();
    const response = await call({ 'x-session-context': bootstrap.contextToken }, 'POST', '/api/session', { userId });
    return { cookie: `keir_demo_session=${response.cookies[0].value}`, 'x-session-context': response.json().contextToken };
  }
  const maya = await login('maya'), leo = await login('leo'), path = `/api/projects/${f.project.id}/capability`;
  assert.equal((await call(leo, 'POST', path + '/approvals', f.input)).statusCode, 403);
  assert.equal((await call(maya, 'POST', path + '/approvals', { ...f.input, actorId: 'sam' })).statusCode, 400);
  assert.equal((await call(maya, 'POST', path + '/approvals', { ...f.input, evidenceId: randomUUID() })).statusCode, 404);
  const approved = await call(maya, 'POST', path + '/approvals', f.input);
  assert.equal(approved.statusCode, 200, approved.body);
  const body = activation(f, approved.json());
  assert.equal((await call(leo, 'POST', path + '/activations', body)).statusCode, 403);
  const result = await call(maya, 'POST', path + '/activations', body);
  assert.equal(result.statusCode, 200, result.body);
  f.teams.setSelection('maya', f.project.id, null);
  const read = await call(maya, 'GET', path + '/operations/' + body.operationId);
  assert.deepEqual(read.json().receipt, result.json().receipt); assert.equal(read.json().current.revisionId, null);
  assert.equal((await call(leo, 'GET', path + '/operations/' + body.operationId)).statusCode, 403);
  const other = taskService(f.db).createProject('maya', { name: 'Other', mode: 'TEAM' });
  assert.equal((await call(maya, 'POST', `/api/projects/${other.id}/capability/approvals`, f.input)).statusCode, 404);
  const personal = taskService(f.db).listProjects('maya').find(p => p.mode === 'PERSONAL');
  assert.equal((await call(maya, 'POST', `/api/projects/${personal.id}/capability/approvals`, f.input)).statusCode, 404);
  assert.equal((await call({ ...maya, 'x-session-context': leo['x-session-context'] }, 'POST', path + '/activations', body)).statusCode, 401);
  const controls = controlInput(f);
  assert.equal((await call(leo, 'GET', path + '/revisions')).statusCode, 403);
  assert.equal((await call(maya, 'GET', path + '/revisions?limit=100')).statusCode, 400);
  assert.equal((await call(maya, 'GET', path + '/revisions')).json().items.length, 1);
  assert.equal((await call(leo, 'POST', path + '/revocations', controls)).statusCode, 403);
  assert.equal((await call(maya, 'POST', path + '/revocations', { ...controls, actorId: 'sam' })).statusCode, 400);
  assert.equal((await call(maya, 'POST', `/api/projects/${other.id}/capability/revocations`, controls)).statusCode, 404);
  const revoke = await call(maya, 'POST', path + '/revocations', controls);
  assert.equal(revoke.statusCode, 200, revoke.body);
  const controlRead = await call(maya, 'GET', path + '/operations/' + controls.operationId);
  assert.deepEqual(controlRead.json().receipt, revoke.json().receipt);
  assert.ok(controlRead.json().target.revokedAt);
  assert.equal((await call(leo, 'GET', path + '/operations/' + controls.operationId)).statusCode, 403);
});

const controlInput = (f, targetRevisionId = f.input.revisionId, overrides = {}) => {
  const selected = f.api.state('maya', f.project.id).selection;
  return { operationId: randomUUID(), targetRevisionId, expectedSelectionRevisionId: selected.revisionId,
    expectedSelectionGeneration: selected.generation, ...overrides };
};
async function selectDraft(f) {
  const approved = await f.api.approve('maya', f.project.id, f.input);
  return f.api.activate('maya', f.project.id, activation(f, approved));
}

test('deactivation affects only new roots; revocation blocks the exact pinned root but not verified children or NO_POLICY work', async t => {
  const f = await setup(t), active = await selectDraft(f), runtime = createTeamRuntime({ db: f.db });
  const tasks = taskService(f.db, { team: runtime });
  try {
    const old = await tasks.createTask('maya', { projectId: f.project.id, title: 'Pinned A' }, { operationId: randomUUID() });
    await runtime.wake();
    const pin = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id);
    const body = controlInput(f), stopped = await f.api.deactivate('maya', f.project.id, body);
    assert.equal(stopped.current.revisionId, null); assert.equal(stopped.current.generation, 2);
    assert.equal(stopped.receipt.result.before.activation.id, active.receipt.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id), pin);
    await tasks.completeTask('leo', pin.child_id); await tasks.completeTask('maya', old.id);
    const uncovered = await tasks.createTask('maya', { projectId: f.project.id, title: 'No policy' }, { operationId: randomUUID() });
    assert.equal((await tasks.completeTask('maya', uncovered.id)).status, 'completed');
    await selectDraft(f);
    const blocked = await tasks.createTask('maya', { projectId: f.project.id, title: 'Revoked A' }, { operationId: randomUUID() });
    await runtime.wake();
    const covered = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(blocked.id);
    const revoked = await f.api.revoke('maya', f.project.id, controlInput(f));
    assert.equal(revoked.current.revisionId, null); assert.equal(revoked.current.generation, 4);
    assert.ok(revoked.target.revokedAt);
    await assert.rejects(tasks.completeTask('maya', blocked.id), { status: 503 });
    assert.equal((await tasks.completeTask('leo', covered.child_id)).status, 'completed');
    assert.equal((await tasks.completeTask('maya', old.id)).status, 'completed');
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(blocked.id), covered);
    assert.equal((await tasks.completeTask('maya', uncovered.id)).status, 'completed');
    assert.throws(() => f.db.exec("UPDATE team_controls SET created_at='changed'"), /immutable/);
  } finally { await runtime.close(); }
});

test('a completed legacy root with a pending creation effect remains an explicit revocation target after B replaces A', async t => {
  const f = await setup(t), runtime = createTeamRuntime({ db: f.db }), tasks = taskService(f.db, { team: runtime });
  try {
    const source = f.api.source('maya', f.project.id, f.input.revisionId);
    installTeamRevision(f.db, 'maya', f.project.id, 'legacy-A', {
      TaskCreated: Buffer.from(source.artifacts[source.manifest.TaskCreated]), TaskBeforeComplete: null,
    });
    f.teams.setSelection('maya', f.project.id, 'legacy-A');
    const old = await tasks.createTask('maya', { projectId: f.project.id, title: 'Completed before dispatch' }, { operationId: randomUUID() });
    await tasks.completeTask('maya', old.id);
    assert.equal(runtime.status('maya', old.id).state, 'PENDING');
    const next = await f.api.propose('maya', f.project.id, { expectedDraftVersion: 1, ...replacement });
    const checked = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 2, revisionId: next.draft.revisionId, cases: next.examples });
    const input = { operationId: randomUUID(), expectedDraftVersion: 2, revisionId: next.draft.revisionId, evidenceId: checked.evidenceId, cases: next.examples };
    const approved = await f.api.approve('maya', f.project.id, input);
    const selected = await f.api.activate('maya', f.project.id, { ...input, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: 1 });
    const target = f.api.revisions('maya', f.project.id, {}).items.find(r => r.revisionId === 'legacy-A');
    assert.equal(target.openRoots, 0); assert.equal(target.pendingEffects, 1);
    assert.equal(target.current, false); assert.equal(target.draft, false);
    const pin = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id);
    const stopped = await f.api.revoke('maya', f.project.id, controlInput(f, 'legacy-A'));
    assert.deepEqual(stopped.current, selected.current);
    assert.deepEqual(stopped.receipt.result.before, stopped.receipt.result.after);
    await runtime.wake();
    assert.equal(tasks.getTask('maya', old.id).status, 'completed');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id=?').get(old.id).n, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id), pin);
    assert.equal(pin.child_id, null); assert.equal(pin.receipt, null);
    assert.deepEqual(f.api.state('maya', f.project.id).selection, selected.current);
    const recent = await tasks.createTask('maya', { projectId: f.project.id, title: 'B still runs' }, { operationId: randomUUID() });
    await runtime.wake();
    assert.equal(f.db.prepare('SELECT revision_id FROM team_admissions WHERE source_task_id=?').get(recent.id).revision_id, next.draft.revisionId);
    assert.equal(tasks.listTasks('maya', f.project.id).find(t => t.parentTaskId === recent.id).title, replacement.title);
    f.db.prepare("UPDATE team_admissions SET state='STARTED',claim=? WHERE event_id=?").run(randomUUID(), pin.event_id);
    const stillListed = f.api.revisions('maya', f.project.id, {}).items.find(r => r.revisionId === 'legacy-A');
    assert.equal(stillListed.openRoots, 0); assert.equal(stillListed.pendingEffects, 1);
  } finally { await runtime.close(); }
});

test('the admin target list pages every persisted revision, including dormant, revoked and source-less targets', async t => {
  const f = await setup(t);
  for (let i = 0; i < 25; i++) f.db.prepare(`INSERT INTO team_revisions(project_id,revision_id,manifest,artifacts,revoked_at)
    SELECT project_id,?,manifest,artifacts,? FROM team_revisions WHERE revision_id=?`)
    .run(`legacy-${String(i).padStart(2, '0')}`, i === 0 ? 100 : null, f.input.revisionId);
  const first = f.api.revisions('maya', f.project.id, {}), second = f.api.revisions('maya', f.project.id, { after: first.next });
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 6); assert.equal(second.next, null);
  const items = [...first.items, ...second.items];
  assert.equal(new Set(items.map(r => r.revisionId)).size, 26);
  assert.equal(items.find(r => r.revisionId === 'legacy-00').revoked, true);
  assert.equal(items.find(r => r.revisionId === 'legacy-24').openRoots, 0);
  assert.equal(items.find(r => r.revisionId === 'legacy-24').draft, false);
  assert.throws(() => f.api.revisions('leo', f.project.id, {}), { status: 403 });
  assert.throws(() => f.api.revisions('maya', f.project.id, { limit: 100 }), { status: 400 });
  assert.throws(() => f.api.revisions('maya', f.project.id, { after: ['x'] }), { status: 404 });
});

test('stop actions need current authority and exact selection, not passing evidence, source, executable artifacts or a configured reviewer', async t => {
  const f = await setup(t);
  f.db.prepare(`INSERT INTO team_revisions(project_id,revision_id,manifest,artifacts) VALUES (?,?,'{}','{}')`).run(f.project.id, 'unusable');
  f.teams.setSelection('maya', f.project.id, 'unusable');
  f.db.exec("DELETE FROM project_members WHERE user_id='leo'");
  const body = controlInput(f, 'unusable');
  await assert.rejects(f.api.deactivate('sam', f.project.id, body), { status: 403 });
  await assert.rejects(f.api.revoke('leo', f.project.id, body), { status: 404 });
  await assert.rejects(f.api.revoke('maya', f.project.id, { ...body, targetRevisionId: randomUUID() }), { status: 404 });
  await assert.rejects(f.api.deactivate('maya', f.project.id, { ...body, targetRevisionId: f.input.revisionId }), { status: 409 });
  const deactivated = await f.api.deactivate('maya', f.project.id, body);
  assert.equal(deactivated.current.revisionId, null);
  const revoked = await f.api.revoke('maya', f.project.id, controlInput(f, 'unusable'));
  assert.ok(revoked.target.revokedAt);
  await assert.rejects(f.api.revoke('maya', f.project.id, controlInput(f, 'unusable')), { status: 409 });
  assert.equal(f.api.readOperation('maya', f.project.id, revoked.receipt.operationId).target.revokedAt, revoked.target.revokedAt);
});

test('stop receipts bind inputs across all action kinds and stay historical after selection changes and later revocation', async t => {
  const f = await setup(t), active = await selectDraft(f), body = controlInput(f);
  const stopped = await f.api.deactivate('maya', f.project.id, body);
  await assert.rejects(f.api.revoke('maya', f.project.id, body), { status: 409 });
  await assert.rejects(f.api.deactivate('maya', f.project.id, { ...body, expectedSelectionGeneration: 0 }), { status: 409 });
  await assert.rejects(f.api.approve('maya', f.project.id, { ...f.input, operationId: body.operationId }), { status: 409 });
  await assert.rejects(f.api.revoke('maya', f.project.id, { ...body, operationId: active.receipt.operationId }), { status: 409 });
  f.teams.setSelection('maya', f.project.id, f.input.revisionId);
  const replay = await f.api.deactivate('maya', f.project.id, body);
  assert.deepEqual(replay.receipt, stopped.receipt); assert.equal(replay.current.generation, 3);
  assert.equal(replay.current.revisionId, f.input.revisionId);
  const revoked = await f.api.revoke('maya', f.project.id, controlInput(f));
  const historical = f.api.readOperation('maya', f.project.id, body.operationId);
  assert.deepEqual(historical.receipt, stopped.receipt); assert.equal(historical.target.revokedAt, revoked.target.revokedAt);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_controls').get().n, 2);
  assert.throws(() => f.db.prepare(`INSERT INTO team_controls VALUES (?,'revocations',?,?, 'maya',?,'{}','{}','now')`)
    .run(randomUUID(), f.project.id, f.input.revisionId, f.input.operationId), /operation already exists/);
  for (const table of ['team_approvals', 'team_activations']) {
    const row = f.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
    row.id = randomUUID(); row.operation_id = body.operationId;
    assert.throws(() => f.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
      .run(...Object.values(row)), /operation already exists/);
  }
});

test('stale ABA snapshots and exhausted selection fences cannot deactivate or partially revoke', async t => {
  const f = await setup(t); await selectDraft(f);
  const body = controlInput(f);
  f.teams.setSelection('maya', f.project.id, null); f.teams.setSelection('maya', f.project.id, body.targetRevisionId);
  for (const method of ['deactivate', 'revoke']) await assert.rejects(f.api[method]('maya', f.project.id, body), { status: 409 });
  f.db.exec('UPDATE team_selections SET generation=9007199254740991');
  const full = controlInput(f);
  for (const method of ['deactivate', 'revoke']) await assert.rejects(f.api[method]('maya', f.project.id, full));
  assert.equal(f.db.prepare('SELECT revoked_at FROM team_revisions WHERE revision_id=?').get(body.targetRevisionId).revoked_at, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_controls').get().n, 0);
});

test('control writes recheck authority, selection, target, cancellation and lease after updates and receipt insertion', async t => {
  for (const method of ['deactivate', 'revoke']) for (const boundary of ['update', 'receipt'])
    for (const change of ['session', 'role', 'selection', 'target', 'abort', 'expiry', 'failure']) await t.test(`${method}/${boundary}/${change}`, async t => {
      let actor = 'maya', time = 100;
      const f = await setup(t, { now: () => time }); await selectDraft(f);
      const body = controlInput(f), before = snapshot(f.db);
      const revision = f.db.prepare('SELECT * FROM team_revisions WHERE revision_id=?').get(body.targetRevisionId);
      const abort = new AbortController();
      f.db.function('fence_control', () => {
        if (change === 'session') actor = 'leo';
        if (change === 'expiry') time = 2100;
        if (change === 'abort') abort.abort();
        return 1;
      });
      const sql = { role: "UPDATE project_members SET role='MEMBER' WHERE user_id='maya';",
        selection: "UPDATE team_selections SET revision_id='" + body.targetRevisionId + "';",
        target: "UPDATE team_revisions SET revoked_at=123 WHERE revision_id='" + body.targetRevisionId + "';",
        failure: "SELECT RAISE(ABORT,'Control insertion failed');" }[change] ?? 'SELECT fence_control();';
      const table = boundary === 'receipt' ? 'team_controls' : method === 'deactivate' ? 'team_selections' : 'team_revisions';
      f.db.exec(`CREATE TEMP TRIGGER control_fence AFTER ${boundary === 'receipt' ? 'INSERT' : 'UPDATE'} ON ${table} BEGIN ${sql} END`);
      await assert.rejects(f.api[method]('maya', f.project.id, body, () => actor, { signal: abort.signal }));
      assert.deepEqual(snapshot(f.db), before);
      assert.deepEqual(f.db.prepare('SELECT * FROM team_revisions WHERE revision_id=?').get(body.targetRevisionId), revision);
    });
});

test('a revoked draft can be replaced under its version fence but cannot be simulated, approved or activated', async t => {
  const f = await setup(t), active = await selectDraft(f);
  const stopped = await f.api.revoke('maya', f.project.id, controlInput(f));
  await assert.rejects(f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: f.input.revisionId, cases: f.input.cases }), { status: 409 });
  await assert.rejects(f.api.approve('maya', f.project.id, { ...f.input, operationId: randomUUID() }), { status: 409 });
  await assert.rejects(f.api.activate('maya', f.project.id, { ...activation(f, { receipt: { id: active.receipt.approvalId } }), operationId: randomUUID() }), { status: 409 });
  const outcomes = await Promise.allSettled([1, 2].map(() => f.api.propose('maya', f.project.id, { expectedDraftVersion: 1, ...replacement })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const next = f.api.state('maya', f.project.id);
  assert.equal(next.draftVersion, 2); assert.notEqual(next.draft.revisionId, f.input.revisionId);
  assert.equal(next.selection.revisionId, null); assert.equal(next.selection.generation, stopped.current.generation);
  const checked = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 2, revisionId: next.draft.revisionId, cases: next.examples });
  const input = { operationId: randomUUID(), expectedDraftVersion: 2, revisionId: next.draft.revisionId, evidenceId: checked.evidenceId, cases: next.examples };
  const approved = await f.api.approve('maya', f.project.id, input);
  const selected = await f.api.activate('maya', f.project.id, { ...input, operationId: randomUUID(), approvalId: approved.receipt.id, expectedSelectionGeneration: stopped.current.generation });
  assert.equal(selected.current.revisionId, next.draft.revisionId);
  assert.ok(f.db.prepare('SELECT revoked_at FROM team_revisions WHERE revision_id=?').get(f.input.revisionId).revoked_at);
});
