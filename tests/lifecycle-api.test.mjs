import test from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { TASK_HOOK } from '../src/extension-catalog.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

let compiledFixture;
const fixture = () => compiledFixture ??= compileTaskCustomization();
let actual;

function extensionPath(db, suffix = '', owner = 'maya') {
  const items = db.prepare("SELECT id FROM extensions WHERE owner_id=? AND creation_operation_id='api-task-draft'").all(owner);
  assert.equal(items.length, 1, 'The fixture has one exact new task draft per owner.');
  return 'extensions/' + items[0].id + (suffix ? '/' + suffix : '');
}

async function compilerReady(ready, requests) {
  let timeout;
  try {
    await Promise.race([ready,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Compiler readiness was not reached within five seconds.')), 5000); }),
      ...requests.map(async request => { const response = await request; assert.fail('Compiler request settled before readiness: HTTP ' + response.statusCode); }),
    ]);
  } finally { clearTimeout(timeout); }
}

async function apiHarness(t, compiler) {
  actual = await fixture();
  compiler ??= { compile: async bytes => {
    assert.equal(Buffer.from(bytes).toString(), actual.source);
    return { artifact: actual.artifactBytes, diagnostics: [] };
  } };
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
  for (const owner of ['maya', 'leo']) admitTaskDraft(db, createLifecycle(db), { owner, operationId: 'api-task-draft' });
  const appPromise = createApp({ db, origin, compiler });
  t.after(async () => { const app = await appPromise; await app.close(); db.close(); });
  return appPromise.then(app => {
    let auth = {};
    const call = (url, body, headers = {}) => app.inject({ url: '/api/' + url, method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers }, ...(body === undefined ? {} : { payload: body }) });
    return { app, db, call, setAuth(value) { auth = value; }, async logout() {
      return app.inject({ url: '/api/session', method: 'DELETE', headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth }, payload: {} });
    }, async login(userId = 'maya') {
      const bootstrap = (await call('session')).json();
      const response = await call('session', { userId }, { 'x-session-context': bootstrap.contextToken });
      auth = { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
      return response;
    } };
  });
}

const validCase = () => actual.cases[0];

test('scoped lifecycle API enforces exact shapes, session, draft/selection versions and real evidence', async t => {
  const { db, call, login, setAuth } = await apiHarness(t);
  await login();
  const initial = (await call(extensionPath(db))).json();
  assert.equal((await call('extensions?owner=leo')).statusCode, 400);
  for (const bad of [{ templateId: 'attention', draftVersion: 0, owner: 'leo' }, { templateId: '../leo.json', draftVersion: 0 }, [], { templateId: 'attention', draftVersion: -1 }])
    assert.equal((await call(extensionPath(db, 'draft'), bad)).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'draft'), { templateId: 'attention', draftVersion: 0 }, { origin: 'http://invalid.local' })).statusCode, 403);
  let state = (await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: 0 })).json();
  state = (await call(extensionPath(db, 'scenarios'), { revisionId: state.draft.id, draftVersion: state.draftVersion, cases: actual.cases })).json();
  const input = { revisionId: state.draft.id, draftVersion: state.draftVersion };
  assert.equal((await call(extensionPath(db, 'approve'), { ...input, evidenceId: 'forged' })).statusCode, 404);
  const proofResponse = await call(extensionPath(db, 'simulate'), input);
  assert.equal(proofResponse.statusCode, 200); state = proofResponse.json();
  assert.equal(state.evidence.passed, true);
  const checked = (await call(extensionPath(db, `evidence/${state.evidence.id}`))).json();
  assert.equal(checked.reports.length, 6);
  assert.equal(checked.reports.find(row => row.id === 'missing-task').report.scenario.task.projectId, undefined, 'Unavailable reads remain inspectable without invented project data.');
  assert.equal((await call(extensionPath(db, 'activate'), { ...input, generation: initial.selection.generation })).statusCode, 409);
  assert.equal((await call(extensionPath(db, 'approve'), { ...input, evidenceId: state.evidence.id, passed: true })).statusCode, 400);
  state = (await call(extensionPath(db, 'approve'), { ...input, evidenceId: state.evidence.id })).json();
  assert.equal(state.approved, true);
  const approvedId = state.evidence.id;
  state = (await call(extensionPath(db, 'simulate'), input)).json();
  assert.notEqual(state.evidence.id, approvedId);
  assert.equal(state.approvedEvidenceId, approvedId);
  assert.equal((await call(extensionPath(db, `evidence/${approvedId}`))).json().id, approvedId);
  state = (await call(extensionPath(db, 'approve'), { ...input, evidenceId: state.evidence.id })).json();
  assert.equal(state.approvedEvidenceId, state.evidence.id);
  const native = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const activated = await call(extensionPath(db, 'activate'), { ...input, generation: initial.selection.generation });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().selection.revision.id, input.revisionId);
  assert.equal(activated.json().selection.approvedEvidenceId, state.approvedEvidenceId);
  assert.equal(activated.json().selection.generation, initial.selection.generation + 1);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), native, 'Activation never executes or replays a task.');
  assert.equal((await call(extensionPath(db, 'disable'), { generation: initial.selection.generation })).statusCode, 409);
  assert.equal((await call(extensionPath(db, 'history?before=-1'))).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'history?owner=leo'))).statusCode, 400);
  const proofId = approvedId;
  await login('leo');
  assert.equal((await call(extensionPath(db, `evidence/${proofId}`))).statusCode, 404);
  assert.equal((await call(extensionPath(db, 'rollback'), { revisionId: input.revisionId, generation: 0 })).statusCode, 404);
  const leoCompiled = (await call(extensionPath(db, 'compile', 'leo'), { hookId: TASK_HOOK, source: actual.source, draftVersion: 0 })).json();
  assert.equal(leoCompiled.selection.generation, 0);
  db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?').run(JSON.stringify({ invalid: 'x'.repeat(263000) }), leoCompiled.draft.id);
  assert.equal((await call(extensionPath(db, '', 'leo'))).statusCode, 413, 'Oversized state is rejected rather than silently truncated');
  setAuth({});
  assert.equal((await call(extensionPath(db))).statusCode, 401);
});

test('authored source and independent suites create immutable revisions; only exact passing evidence can approve or activate', async t => {
  const { db, call, login } = await apiHarness(t);
  await login();
  const selected = (await call(extensionPath(db))).json().selection;
  const compiled = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, label: 'Manual check', draftVersion: 0 });
  assert.equal(compiled.statusCode, 200);
  let state = compiled.json();
  const sourceRevision = state.draft.id;
  assert.equal(state.draft.kind, 'authored');
  assert.equal(state.draft.suiteDigest, null);
  assert.equal(state.draftVersion, 1);
  assert.equal((await call(extensionPath(db, 'revisions/' + sourceRevision))).json().cases.length, 0);
  assert.equal((await call(extensionPath(db, 'simulate'), { revisionId: sourceRevision, draftVersion: 1 })).statusCode, 409);

  const original = JSON.parse(validCase());
  original.expect.outcome.result.status = 'NO_OP';
  original.expect.consumption.result.status = 'NO_OP';
  const wrong = JSON.stringify(original);
  const proposed = await call(extensionPath(db, 'scenarios'), { revisionId: sourceRevision, cases: [wrong], draftVersion: 1 });
  assert.equal(proposed.statusCode, 200);
  state = proposed.json();
  const wrongRevision = state.draft.id;
  assert.notEqual(wrongRevision, sourceRevision);
  assert.notEqual(state.suiteDigest, null);
  assert.equal(state.draftVersion, 2);
  assert.equal((await call(extensionPath(db, 'revisions/' + sourceRevision))).json().cases.length, 0);
  const originalBytes = db.prepare('SELECT source,artifact FROM extension_authored WHERE revision_id=?').get(sourceRevision);
  const changedBytes = db.prepare('SELECT source,artifact,suite FROM extension_authored WHERE revision_id=?').get(wrongRevision);
  assert.deepEqual(Buffer.from(changedBytes.source), Buffer.from(originalBytes.source));
  assert.deepEqual(Buffer.from(changedBytes.artifact), Buffer.from(originalBytes.artifact));
  assert.equal(changedBytes.suite, JSON.stringify([wrong]));
  const failed = await call(extensionPath(db, 'simulate'), { revisionId: wrongRevision, draftVersion: 2 });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().evidence.passed, false);
  assert.equal((await call(extensionPath(db, 'approve'), { revisionId: wrongRevision, draftVersion: 2, evidenceId: failed.json().evidence.id })).statusCode, 409);
  assert.deepEqual((await call(extensionPath(db))).json().selection, selected, 'Saving or simulating a draft changes no selection');

  const proposals = await Promise.all([
    call(extensionPath(db, 'scenarios'), { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 }),
    call(extensionPath(db, 'scenarios'), { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 }),
  ]);
  assert.deepEqual(proposals.map(response => response.statusCode).sort(), [200, 409]);
  const corrected = proposals.find(response => response.statusCode === 200);
  assert.ok(corrected);
  state = corrected.json();
  const correctedRevision = state.draft.id;
  assert.notEqual(correctedRevision, wrongRevision);
  assert.equal(state.draftVersion, 3);
  assert.equal((await call(extensionPath(db, 'scenarios'), { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 })).statusCode, 409);
  state = (await call(extensionPath(db, 'simulate'), { revisionId: correctedRevision, draftVersion: 3 })).json();
  assert.equal(state.evidence.passed, true);
  state = (await call(extensionPath(db, 'approve'), { revisionId: correctedRevision, draftVersion: 3, evidenceId: state.evidence.id })).json();
  assert.equal(state.approved, true);
  assert.deepEqual(state.selection, selected);
  const active = await call(extensionPath(db, 'activate'), { revisionId: correctedRevision, draftVersion: 3, generation: state.selection.generation });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().selection.revision.id, correctedRevision);
  assert.equal(active.json().selection.approvedEvidenceId, state.approvedEvidenceId);
  assert.equal(active.json().selection.eligible, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_completion_events').get().n, 0, 'Approval and activation capture no native completion.');
});

test('authored API keeps owner and artifact authority host-bound and rejects malformed scenario strings', async t => {
  const { db, call, login } = await apiHarness(t);
  await login();
  assert.equal((await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: 0, owner: 'leo' })).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: 0, artifact: 'forged', pins: {}, templateId: 'attention' })).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: '', draftVersion: 0 })).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: 'x'.repeat(65537), draftVersion: 0 })).statusCode, 400);
  const compiled = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: 0 });
  const revisionId = compiled.json().draft.id;
  assert.equal((await call(extensionPath(db, 'revisions/' + revisionId), undefined, { 'x-session-context': 'wrong' })).statusCode, 401);
  await login('leo');
  assert.equal((await call(extensionPath(db, 'revisions/' + revisionId))).statusCode, 404);
  await login('maya');
  const duplicateKey = validCase().replace(/"id"\s*:\s*"[^"]+"/, '$&,"id":"duplicate"');
  const badCases = ['', '{', duplicateKey, '[]'];
  for (const value of badCases) {
    const response = await call(extensionPath(db, 'scenarios'), { revisionId, cases: [value], draftVersion: 1 });
    assert.ok([400, 409].includes(response.statusCode), `rejected case ${JSON.stringify(value)}`);
    assert.equal((await call(extensionPath(db))).json().draft.id, revisionId);
  }
  assert.equal((await call(extensionPath(db, 'scenarios'), { revisionId, cases: [], draftVersion: 1 })).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'scenarios'), { revisionId, cases: [validCase()], draftVersion: 1, artifact: 'forged' })).statusCode, 400);
  const oversized = 'x'.repeat(65537);
  assert.equal((await call(extensionPath(db, 'scenarios'), { revisionId, cases: [oversized], draftVersion: 1 })).statusCode, 400);
  assert.equal((await call(extensionPath(db, 'scenarios'), { revisionId, cases: ['x'.repeat(45000), 'y'.repeat(45000), 'z'.repeat(45000)], draftVersion: 1 })).statusCode, 413);
});

test('compile diagnostics and concurrent/stale or revoked async completions never persist source revisions', async t => {
  let releases = [];
  let diagnostic = false;
  let expectedEntries = 2, entered;
  let ready = new Promise(resolve => { entered = resolve; });
  const compiler = { compile: async () => {
    if (diagnostic) return { artifact: null, diagnostics: [{ code: 'PARSE_ERROR', path: '/steps/0' }] };
    await new Promise(resolve => { releases.push(resolve); if (releases.length === expectedEntries) entered(); });
    return { artifact: actual.artifactBytes, diagnostics: [] };
  } };
  const { db, call, login, logout, setAuth } = await apiHarness(t, compiler);
  await login();
  const first = call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, label: 'First', draftVersion: 0 });
  const second = call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, label: 'Second', draftVersion: 0 });
  try { await compilerReady(ready, [first, second]); }
  finally { releases.splice(0).forEach(resolve => resolve()); }
  const concurrent = await Promise.all([first, second]);
  assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='maya'").get().n, 1);

  diagnostic = true;
  const current = (await call(extensionPath(db))).json();
  const rejected = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: current.draftVersion });
  assert.equal(rejected.statusCode, 422);
  assert.deepEqual(rejected.json().diagnostics, [{ code: 'PARSE_ERROR', path: '/steps/0' }]);
  assert.equal((await call(extensionPath(db))).json().revisionId, current.revisionId);

  diagnostic = false;
  expectedEntries = 1; ready = new Promise(resolve => { entered = resolve; });
  const pending = call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source: actual.source, draftVersion: current.draftVersion });
  try { await compilerReady(ready, [pending]); }
  catch (error) { releases.splice(0).forEach(resolve => resolve()); throw error; }
  assert.equal((await logout()).statusCode, 200);
  setAuth({});
  const replacement = await login('leo');
  assert.equal(replacement.statusCode, 200);
  releases.splice(0).forEach(resolve => resolve());
  assert.equal((await pending).statusCode, 401);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='maya'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='leo'").get().n, 0);
});
