import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { normalizeTeamCases, simulateTeam } from '../src/team-simulation.mjs';
import { digest, json } from '../src/extension-catalog.mjs';

let compiler;
const input = { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: '' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
before(async () => {
  const db = openData(':memory:'), project = taskService(db).createProject('maya', { name: 'Compile once', mode: 'TEAM' });
  teamProjectService(db).addMember('maya', project.id, { userId: 'leo' });
  const api = createTeamCapability(db);
  try {
    const state = await api.propose('maya', project.id, input);
    const saved = api.source('maya', project.id, state.draft.revisionId), cache = new Map();
    for (const [hook, text] of Object.entries(saved.sourceBundle.sources)) cache.set(text, Buffer.from(saved.artifacts[saved.manifest[hook]]));
    compiler = { async compile(bytes) { assert.ok(cache.has(bytes.toString())); return { artifact: cache.get(bytes.toString()), diagnostics: [] }; } };
  } finally { await api.close(); db.close(); }
});
async function setup(t, seams) {
  const db = openData(':memory:'), api = createTeamCapability(db, { compiler }, seams);
  const project = taskService(db).createProject('maya', { name: 'Simulation team', mode: 'TEAM' });
  teamProjectService(db).addMember('maya', project.id, { userId: 'leo' });
  const state = await api.propose('maya', project.id, input);
  t.after(async () => { await api.close(); db.close(); });
  return { db, api, project, state, body: { expectedDraftVersion: 1, revisionId: state.draft.revisionId, cases: state.examples } };
}
const evidenceCount = db => db.prepare('SELECT count(*) AS n FROM team_evidence').get().n;

test('six independent real private native cases pass, preserve operator bytes and distinguish uncertainty from receipts', async t => {
  const f = await setup(t);
  const snapshot = () => ['tasks', 'team_admissions', 'team_selections', 'team_revisions', 'task_create_operations', 'extension_selections']
    .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  const state = await f.api.simulate('maya', f.project.id, f.body);
  assert.deepEqual(snapshot(), before);
  const e = f.api.evidence('maya', f.project.id, state.evidenceId);
  assert.equal(e.report.passed, true); assert.equal(e.report.cases.length, 6);
  assert.equal(e.executableIdentity, f.state.draft.manifest.executableIdentity);
  assert.equal(e.caseDigest, digest(json(e.cases)));
  const lost = e.report.cases.find(c => c.id === 'lost-reply'), noWrite = e.report.cases.find(c => c.id === 'fenced-no-write');
  assert.equal(lost.events[1].observed.outcome, 'UNCERTAIN');
  assert.equal(lost.events[1].observed.receipt, 'CONFIRMED');
  assert.equal(lost.events[2].observed.effect, 'CONFIRMED');
  assert.deepEqual(lost.events[2].runtime, lost.events[1].runtime);
  assert.equal(noWrite.events[1].observed.outcome, 'UNCERTAIN');
  assert.equal(noWrite.events[2].observed.effect, 'NONE');
  assert.deepEqual(noWrite.events[3].runtime, noWrite.events[1].runtime);
  assert.equal(noWrite.events[3].native.writeAttempts, 1);
  assert.equal(noWrite.events[4].observed.decision, 'DENY');
  const receipt = lost.events[1].native.receipt;
  assert.equal(receipt.eventId, lost.events[1].native.eventId);
  assert.equal(JSON.parse(receipt.payload).parentTaskId, lost.events[1].native.taskId);
  assert.equal(receipt.result.effect, 'CONFIRMED');
  assert.throws(() => f.db.prepare("UPDATE team_evidence SET passed=0").run(), /immutable/);
});

test('a non-admin member cannot complete another reviewer’s assigned linked task and leaves it open', async t => {
  const f = await setup(t), example = structuredClone(f.body.cases.find(c => c.id === 'success'));
  example.id = 'wrong-assignee';
  example.name = 'Another member cannot complete the assigned review';
  example.actors.push({ id: 'teammate', role: 'MEMBER' });
  example.actions.splice(3, 0, { op: 'complete', actor: 'teammate', ref: 'root.review',
    expect: { decision: 'BLOCKED', status: 'open' } });
  const state = await f.api.simulate('maya', f.project.id, { ...f.body, cases: [example] });
  const evidence = f.api.evidence('maya', f.project.id, state.evidenceId);
  const events = evidence.report.cases[0].events, denied = events[3], assigned = events[4];
  assert.equal(evidence.passed, true);
  assert.equal(evidence.executableIdentity, f.state.draft.manifest.executableIdentity);
  assert.equal(evidence.cases[0].actors.find(a => a.id === 'teammate').role, 'MEMBER');
  assert.equal(JSON.parse(events[1].native.receipt.payload).assigneeId, 'leo');
  assert.equal(denied.observed.decision, 'BLOCKED');
  assert.equal(denied.observed.status, 'open');
  assert.equal(denied.native.taskId, events[1].native.receipt.result.value.id);
  assert.equal(assigned.native.taskId, denied.native.taskId);
  assert.equal(assigned.observed.decision, 'ALLOW');
  assert.equal(assigned.observed.status, 'completed');
});

test('an intentionally wrong independent expectation persists FAIL, never alters source, and keeps the earlier report inspectable', async t => {
  const f = await setup(t), source = f.api.source('maya', f.project.id, f.body.revisionId);
  const good = await f.api.simulate('maya', f.project.id, f.body);
  const cases = structuredClone(f.body.cases);
  cases[0].actions[2].expect.decision = 'ALLOW';
  const bad = await f.api.simulate('maya', f.project.id, { ...f.body, cases });
  const failure = f.api.evidence('maya', f.project.id, bad.evidenceId);
  assert.equal(failure.passed, false);
  assert.deepEqual(failure.report.cases[0].events[2].mismatches, [{ path: 'actions/2/decision', expected: 'ALLOW', observed: 'DENY' }]);
  assert.equal(f.api.evidence('maya', f.project.id, good.evidenceId).passed, true);
  assert.notEqual(failure.caseDigest, f.api.evidence('maya', f.project.id, good.evidenceId).caseDigest);
  assert.deepEqual(f.api.source('maya', f.project.id, f.body.revisionId), source);
  assert.equal(f.db.prepare('SELECT revision_id FROM team_selections').get().revision_id, null);
});

test('closed format rejects excessive actors/tasks/actions/cases/bytes, unknown faults, missing observations and foreign ref before allocation', async t => {
  let allocations = 0;
  const f = await setup(t, { simulate: () => { allocations++; assert.fail('invalid simulation allocated'); } });
  const sample = f.body.cases[0], clone = () => structuredClone(sample);
  const invalid = [[], [{ ...clone(), actions: [null] }], Array.from({ length: 9 }, (_, i) => ({ ...clone(), id: 'case-' + i })),
    [{ ...clone(), fault: 'PRODUCTION' }], [{ ...clone(), actorId: 'maya' }],
    [{ ...clone(), actors: Array.from({ length: 5 }, (_, i) => ({ id: 'a-' + i, role: 'ADMIN' })) }],
    [{ ...clone(), initialTasks: Array.from({ length: 17 }, (_, i) => ({ ref: 't-' + i, actor: 'author', title: 'Initial' })) }],
    [{ ...clone(), actions: Array.from({ length: 9 }, () => clone().actions[0]) }],
    [{ ...clone(), actions: [{ op: 'create', actor: 'author', ref: 'r', title: 'T', expect: {} }] }],
    [{ ...clone(), actions: [{ op: 'dispatch', ref: 'missing', expect: { children: 0, outcome: 'NONE', receipt: 'NONE' } }] }],
    [{ ...clone(), name: 'é'.repeat(17000) }]];
  for (const cases of invalid) await assert.rejects(f.api.simulate('maya', f.project.id, { ...f.body, cases }));
  assert.equal(allocations, 0); assert.equal(evidenceCount(f.db), 0);
  assert.throws(() => normalizeTeamCases([{ ...clone(), actions: [{ ...sample.actions[0], effectKey: 'foreign' }] }]));
});

test('empty initialization rejects file paths before open and never seeds ordinary demo data', () => {
  assert.throws(() => openData('must-not-open.sqlite', { seed: false }), /only allowed in memory/);
  const db = openData(':memory:', { seed: false });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
     assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  } finally { db.close(); }
});

test('cancellation inside a real native reaction closes its private store and cannot save evidence', async t => {
  const abort = new AbortController(); let clockReads = 0, privateCloses = 0;
  const f = await setup(t, { simulate: (bundle, lease) => simulateTeam(bundle, { ...lease, now: () => {
    if (++clockReads === 6) abort.abort();
    return lease.now();
  } }) });
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { if (this !== f.db) privateCloses++; return close.call(this); };
  try { await assert.rejects(f.api.simulate('maya', f.project.id, f.body, undefined, { signal: abort.signal })); }
  finally { DatabaseSync.prototype.close = close; }
  assert.ok(clockReads >= 6); assert.equal(privateCloses, 1); assert.equal(evidenceCount(f.db), 0);
});

test('held simulation and final inserts recheck session, role, reviewer, draft, revocation, cancellation and monotonic deadlines', async t => {
  for (const change of ['session', 'role', 'reviewer', 'draft', 'revocation', 'abort', 'expiry', 'clock-backward', 'postinsert-session', 'postinsert-expiry']) {
    await t.test(change, async t => {
      const entered = deferred(), release = deferred(), abort = new AbortController();
      let actor = 'maya', time = 100;
      const f = await setup(t, { now: () => time, simulate: async (bundle, lease) => {
        const report = await simulateTeam(bundle, lease); entered.resolve(); await release.promise; return report;
      } });
      const pending = f.api.simulate('maya', f.project.id, f.body, () => actor, { signal: abort.signal });
      await entered.promise;
      if (change === 'session') actor = 'leo';
      if (change === 'role') f.db.prepare("UPDATE project_members SET role='MEMBER' WHERE user_id='maya'").run();
      if (change === 'reviewer') f.db.prepare("DELETE FROM project_members WHERE user_id='leo'").run();
      if (change === 'draft') f.db.prepare('UPDATE team_drafts SET draft_version=2').run();
      if (change === 'revocation') teamProjectService(f.db).revoke('maya', f.project.id, f.body.revisionId);
      if (change === 'abort') abort.abort();
      if (change === 'expiry') time = 15100;
      if (change === 'clock-backward') time = 99;
      if (change.startsWith('postinsert')) {
        f.db.function('expired', () => { if (change === 'postinsert-session') actor = 'leo'; else time = 15100; return 1; });
        f.db.exec('CREATE TEMP TRIGGER fence AFTER INSERT ON team_evidence BEGIN SELECT expired(); END');
      }
      release.resolve(); await assert.rejects(pending);
      assert.equal(evidenceCount(f.db), 0);
    });
  }
});

test('one per project and two per app slots reject busy before allocation and remain held through teardown', async t => {
  const release = deferred(), entered = deferred(); let allocations = 0;
  const f = await setup(t, { simulate: async (bundle, lease) => {
    allocations++; if (allocations === 2) entered.resolve(); await release.promise; return simulateTeam(bundle, lease);
  } });
  const prepare = async name => {
    const p = taskService(f.db).createProject('maya', { name, mode: 'TEAM' });
    teamProjectService(f.db).addMember('maya', p.id, { userId: 'leo' });
    return { p, state: await f.api.propose('maya', p.id, input) };
  };
  const second = await prepare('Second'), third = await prepare('Third');
  const a = f.api.simulate('maya', f.project.id, f.body);
  await assert.rejects(f.api.simulate('maya', f.project.id, f.body), { status: 409 });
  const b = f.api.simulate('maya', second.p.id, { ...f.body, revisionId: second.state.draft.revisionId });
  await entered.promise;
  await assert.rejects(f.api.simulate('maya', third.p.id, { ...f.body, revisionId: third.state.draft.revisionId }), { status: 409 });
  assert.equal(allocations, 2); release.resolve();
  await Promise.all([a, b]); assert.equal(evidenceCount(f.db), 2);
  await f.api.simulate('maya', third.p.id, { ...f.body, revisionId: third.state.draft.revisionId });
  assert.equal(evidenceCount(f.db), 3);
});

test('expired remaining invocation budget, oversized stored reports and changed exact artifacts cannot yield evidence', async t => {
  for (const mode of ['remaining', 'report', 'artifact']) await t.test(mode, async t => {
    let time = 0;
    const f = await setup(t, { now: () => time, simulate: async (bundle, lease) => {
      if (mode === 'remaining') time = 14500;
      if (mode === 'artifact') bundle.artifacts[bundle.manifest.TaskCreated] += ' ';
      const result = await simulateTeam(bundle, lease);
      if (mode === 'report') result.padding = 'x'.repeat(262144);
      return result;
    } });
    await assert.rejects(f.api.simulate('maya', f.project.id, f.body));
    assert.equal(evidenceCount(f.db), 0);
  });
});

test('a cancelled run retains its project slot until teardown actually settles', async t => {
  const entered = deferred(), work = deferred(), teardown = deferred(), releaseTeardown = deferred(), abort = new AbortController();
  let first = true;
  const f = await setup(t, { simulate: async (bundle, lease) => {
    if (!first) return simulateTeam(bundle, lease);
    first = false; entered.resolve(); await work.promise;
    try { return await simulateTeam(bundle, lease); }
    finally { teardown.resolve(); await releaseTeardown.promise; }
  } });
  const pending = f.api.simulate('maya', f.project.id, f.body, undefined, { signal: abort.signal });
  await entered.promise; abort.abort(); work.resolve(); await teardown.promise;
  await assert.rejects(f.api.simulate('maya', f.project.id, f.body), { status: 409 });
  assert.equal(evidenceCount(f.db), 0);
  releaseTeardown.resolve(); await assert.rejects(pending);
  await f.api.simulate('maya', f.project.id, f.body);
  assert.equal(evidenceCount(f.db), 1);
});
