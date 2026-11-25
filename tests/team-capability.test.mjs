import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { teamModelBytes } from '../src/team-runtime.mjs';
import { digest, json } from '../src/extension-catalog.mjs';
import { createApp } from '../src/app.mjs';

function setup(t, options, seams) {
  const db = openData(':memory:'), project = taskService(db).createProject('maya', { name: 'Capability team', mode: 'TEAM' });
  teamProjectService(db).addMember('maya', project.id, { userId: 'leo' });
  const api = createTeamCapability(db, options, seams);
  const f = { db, project, api, app: null, input: { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: 'Scripted offline example' } };
  t.after(async () => { await f.app?.close(); await api.close(); db.close(); });
  return f;
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('real two-hook proposal stores exact source/producer identities, immutable revision and separate draft with no selection/task changes', async t => {
  const f = setup(t), before = f.db.prepare('SELECT * FROM team_selections').all();
  const state = await f.api.propose('maya', f.project.id, f.input, () => 'maya');
  assert.equal(state.draftVersion, 1); assert.equal(state.selected, null); assert.equal(state.evidence, null);
  const saved = f.api.source('maya', f.project.id, state.draft.revisionId);
  assert.equal(saved.sourceBundle.parameters.intent, f.input.intent);
  for (const hook of ['TaskCreated', 'TaskBeforeComplete']) {
    const pins = saved.sourceBundle.hooks[hook], artifact = JSON.parse(saved.artifacts[pins.artifactDigest]);
    assert.equal(pins.rawSourceDigest, digest(saved.sourceBundle.sources[hook]));
    assert.equal(artifact.sourceDigest, pins.sourceDigest);
    assert.equal(artifact.compiler, saved.sourceBundle.compiler.compiler);
    assert.equal(digest(saved.artifacts[pins.artifactDigest]), pins.artifactDigest);
    assert.equal(artifact.entrypoint, hook); assert.equal(pins.present, true);
  }
  assert.equal(saved.manifest.executableIdentity, digest(json({ projectId: f.project.id, modelDigest: saved.manifest.modelDigest,
    grants: saved.manifest.grants, sourceBundle: saved.sourceBundle })));
  assert.throws(() => f.db.prepare("UPDATE team_revisions SET source_bundle='{}'").run(), /immutable/);
  assert.deepEqual(f.db.prepare('SELECT * FROM team_selections').all(), before);
  assert.equal(count(f.db, 'team_admissions'), 0);
  const changed = await f.api.propose('maya', f.project.id, { ...f.input, expectedDraftVersion: 1, title: 'Different review' }, () => 'maya');
  assert.notEqual(changed.draft.revisionId, saved.revisionId);
  assert.notEqual(changed.draft.manifest.executableIdentity, saved.manifest.executableIdentity);
  assert.deepEqual(f.api.source('maya', f.project.id, saved.revisionId), saved);
});

test('closed proposal input and UTF8/native bounds fail before compilation or insertion', async t => {
  let calls = 0;
  const f = setup(t, { compiler: { compile() { calls++; assert.fail('invalid input compiled'); } } });
  const invalid = [
    { ...f.input, actor: 'maya' }, { ...f.input, reviewerId: 'sam' }, { ...f.input, title: '' },
    { ...f.input, title: 'a'.repeat(121) }, { ...f.input, title: '\u0000' }, { ...f.input, title: '\ud800' },
    { ...f.input, intent: 'é'.repeat(2049) }, { ...f.input, expectedDraftVersion: -1 }, { ...f.input, artifacts: {} },
  ];
  for (const input of invalid) await assert.rejects(f.api.propose('maya', f.project.id, input, () => 'maya'));
  assert.equal(calls, 0); assert.equal(count(f.db, 'team_revisions'), 0);
  for (const [actor, status] of [['leo', 403], ['sam', 404]])
    await assert.rejects(f.api.propose(actor, f.project.id, f.input, () => actor), { status });
  const personal = taskService(f.db).listProjects('maya').find(p => p.mode === 'PERSONAL');
  assert.throws(() => f.api.state('maya', personal.id), { status: 404 });
});

test('partial second-hook compilation, changed artifact identity and cancelled compiler cannot persist', async t => {
  const real = createCompiler({ modelBytes: teamModelBytes });
  for (const mode of ['second-missing', 'identity', 'artifact-limit', 'cancel']) await t.test(mode, async t => {
    let calls = 0;
    const abort = new AbortController();
    const f = setup(t, { compiler: { async compile(bytes, context) {
      calls++;
      if (mode === 'artifact-limit') return { artifact: Buffer.alloc(1048577), diagnostics: [] };
      if (mode === 'second-missing' && calls === 2) return { artifact: null, diagnostics: [] };
      const result = await real.compile(bytes, context);
      if (mode === 'identity') {
        const a = JSON.parse(result.artifact); a.sourceDigest = digest('foreign');
        return { ...result, artifact: Buffer.from(json(a)) };
      }
      if (mode === 'cancel' && calls === 2) abort.abort();
      return result;
    } } });
    await assert.rejects(f.api.propose('maya', f.project.id, f.input, () => 'maya', { signal: abort.signal }));
    assert.equal(count(f.db, 'team_revisions'), 0); assert.equal(f.api.state('maya', f.project.id).draftVersion, 0);
  });
});

test('held compile is fenced by session, admin, reviewer, draft and deadline changes', async t => {
  const real = createCompiler({ modelBytes: teamModelBytes });
  for (const change of ['session', 'role', 'reviewer', 'draft', 'expiry', 'clock-backward', 'close']) await t.test(change, async t => {
    const entered = deferred(), release = deferred(); let time = 10, actor = 'maya';
    const f = setup(t, { compiler: { async compile(bytes, context) {
      const result = await real.compile(bytes, context); entered.resolve(); await release.promise; return result;
    } } }, { now: () => time });
    const pending = f.api.propose('maya', f.project.id, f.input, () => actor);
    await entered.promise;
    if (change === 'session') actor = 'leo';
    if (change === 'role') f.db.prepare("UPDATE project_members SET role='MEMBER' WHERE user_id='maya'").run();
    if (change === 'reviewer') f.db.prepare("DELETE FROM project_members WHERE user_id='leo'").run();
    if (change === 'draft') f.db.prepare('UPDATE team_drafts SET draft_version=1').run();
    if (change === 'expiry') time = 25010;
    if (change === 'clock-backward') time = 9;
    let closing; if (change === 'close') closing = f.api.close();
    release.resolve();
    await assert.rejects(pending); await closing;
    assert.equal(count(f.db, 'team_revisions'), 0);
  });
});

test('postinsert session/reviewer/deadline fences roll back source and draft CAS', async t => {
  const real = createCompiler({ modelBytes: teamModelBytes });
  for (const phase of ['session-insert', 'reviewer-insert', 'lease-cas', 'cas-count']) await t.test(phase, async t => {
    let actor = 'maya', time = 1;
    const f = setup(t, { compiler: real }, { now: () => time });
    if (phase === 'session-insert') {
      f.db.function('expire_session', () => { actor = 'leo'; return 1; });
      f.db.exec('CREATE TEMP TRIGGER fence AFTER INSERT ON team_revisions BEGIN SELECT expire_session(); END');
    }
    if (phase === 'reviewer-insert') f.db.exec("CREATE TEMP TRIGGER fence AFTER INSERT ON team_revisions BEGIN DELETE FROM project_members WHERE user_id='leo'; END");
    if (phase === 'lease-cas') {
      f.db.function('expire_lease', () => { time = 25001; return 1; });
      f.db.exec('CREATE TEMP TRIGGER fence AFTER UPDATE ON team_drafts BEGIN SELECT expire_lease(); END');
    }
    if (phase === 'cas-count') f.db.exec('CREATE TEMP TRIGGER fence BEFORE UPDATE ON team_drafts BEGIN SELECT RAISE(IGNORE); END');
    await assert.rejects(f.api.propose('maya', f.project.id, f.input, () => actor));
    assert.equal(count(f.db, 'team_revisions'), 0);
    assert.equal(f.db.prepare('SELECT draft_version FROM team_drafts').get().draft_version, 0);
    assert.ok(f.db.prepare("SELECT 1 FROM project_members WHERE user_id='leo'").get());
  });
});

test('two concurrent preparations for one version have exactly one CAS winner', async t => {
  const compiled = new Map();
  const warm = setup(t);
  const state = await warm.api.propose('maya', warm.project.id, warm.input);
  const saved = warm.api.source('maya', warm.project.id, state.draft.revisionId);
  for (const [hook, source] of Object.entries(saved.sourceBundle.sources)) compiled.set(source, Buffer.from(saved.artifacts[saved.manifest[hook]]));
  const gates = [], entered = deferred(), release = deferred();
  const f = setup(t, { compiler: { async compile(bytes) {
    const artifact = compiled.get(bytes.toString());
    assert.ok(artifact); gates.push(1); if (gates.length === 2) entered.resolve();
    if (gates.length <= 2) await release.promise;
    return { artifact, diagnostics: [] };
  } } });
  // The scripted sources have no host project literal; each executable identity still binds its actual project.
  const a = f.api.propose('maya', f.project.id, f.input), b = f.api.propose('maya', f.project.id, f.input);
  await entered.promise; release.resolve();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(count(f.db, 'team_revisions'), 1); assert.equal(f.api.state('maya', f.project.id).draftVersion, 1);
});

test('ordinary HTTP admin-only exact project/revision/evidence routes and closed body/query limits', async t => {
  const f = setup(t), origin = 'http://127.0.0.1:32089';
  const app = await createApp({ db: f.db, origin, staticRoot: fileURLToPath(new URL('../dist/', import.meta.url)) });
  f.app = app;
  const call = (auth, method, url, payload) => app.inject({ method, url, headers: { host: '127.0.0.1:32089', origin, 'content-type': 'application/json', ...auth },
    ...(payload === undefined ? {} : { payload }) });
  async function login(userId) {
    const anon = (await call({}, 'GET', '/api/session')).json();
    const r = await call({ 'x-session-context': anon.contextToken }, 'POST', '/api/session', { userId });
    return { cookie: `keir_demo_session=${r.cookies[0].value}`, 'x-session-context': r.json().contextToken };
  }
  const maya = await login('maya'), leo = await login('leo'), sam = await login('sam');
  const path = `/api/projects/${f.project.id}/capability`;
  for (const [auth, status] of [[leo, 403], [sam, 404]])
    for (const [method, suffix, payload] of [['GET', '', undefined], ['POST', '/proposals', f.input], ['POST', '/simulations', {}],
      ['GET', '/revisions/foreign', undefined], ['GET', '/evidence/foreign', undefined]])
      assert.equal((await call(auth, method, path + suffix, payload)).statusCode, status);
  assert.equal((await call(maya, 'GET', path + '?actor=leo')).statusCode, 400);
  assert.equal((await call(maya, 'POST', path + '/proposals', { ...f.input, owner: 'maya' })).statusCode, 400);
  assert.equal((await call(maya, 'POST', path + '/proposals', { ...f.input, intent: 'a'.repeat(17000) })).statusCode, 413);
  const r = await call(maya, 'POST', path + '/proposals', f.input);
  assert.equal(r.statusCode, 200, r.body); const state = r.json();
  assert.equal((await call(maya, 'GET', `${path}/revisions/${state.draft.revisionId}`)).statusCode, 200);
  const simulation = await call(maya, 'POST', path + '/simulations', { expectedDraftVersion: 1, revisionId: state.draft.revisionId, cases: state.examples });
  assert.equal(simulation.statusCode, 200, simulation.body);
  const evidenceId = simulation.json().evidenceId;
  const e = await call(maya, 'GET', path + '/evidence/' + evidenceId);
  assert.equal(e.statusCode, 200); assert.equal(e.json().passed, true);
  const other = taskService(f.db).createProject('maya', { name: 'Other team', mode: 'TEAM' });
  for (const suffix of [`revisions/${state.draft.revisionId}`, `evidence/${evidenceId}`])
    assert.equal((await call(maya, 'GET', `/api/projects/${other.id}/capability/${suffix}`)).statusCode, 404);
  for (const action of ['approve', 'activate', 'repair'])
    assert.equal((await call(maya, 'POST', path + '/' + action, {})).statusCode, 404);
  assert.equal((await call({ ...maya, 'x-session-context': leo['x-session-context'] }, 'GET', path)).statusCode, 401);
  const native = await taskService(f.db).createTask('maya', { projectId: f.project.id, title: 'No activated rules' }, { operationId: randomUUID() });
  assert.equal(f.db.prepare('SELECT policy_state FROM team_admissions WHERE source_task_id=?').get(native.id).policy_state, 'NO_POLICY');
});
