import test from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { loadCatalog } from '../src/extension-catalog.mjs';
import { simulationCases } from '../src/extension-lifecycle.mjs';

function apiHarness(t, compiler = { compile: async () => ({ artifact: loadCatalog().find(item => item.id === 'attention').artifactBytes, diagnostics: [] }) }) {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
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

const validCase = () => simulationCases('attention')[0].bytes.toString();

test('scoped lifecycle API enforces exact shapes, session, draft/selection versions and real evidence', async t => {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin }); t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (url, body, headers = {}) => app.inject({ url: '/api/' + url, method: body === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers }, ...(body === undefined ? {} : { payload: body }) });
  const bootstrap = (await call('session')).json();
  const login = await call('session', { userId: 'maya' }, { 'x-session-context': bootstrap.contextToken });
  auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-session-context': login.json().contextToken };
  const initial = (await call('extensions')).json();
  assert.equal((await call('extensions?owner=leo')).statusCode, 400);
  for (const bad of [{ templateId: 'attention', draftVersion: 0, owner: 'leo' }, { templateId: '../leo.json', draftVersion: 0 }, [], { templateId: 'attention', draftVersion: -1 }])
    assert.equal((await call('extensions/draft', bad)).statusCode, 400);
  assert.equal((await call('extensions/draft', { templateId: 'attention', draftVersion: 0 }, { origin: 'http://invalid.local' })).statusCode, 403);
  let state = (await call('extensions/draft', { templateId: 'attention', draftVersion: 0 })).json();
  const input = { revisionId: state.draft.id, draftVersion: state.draftVersion };
  assert.equal((await call('extensions/approve', { ...input, evidenceId: 'forged' })).statusCode, 404);
  const proofResponse = await call('extensions/simulate', input);
  assert.equal(proofResponse.statusCode, 200); state = proofResponse.json();
  assert.equal(state.evidence.passed, true);
  assert.equal((await call(`extensions/evidence/${state.evidence.id}`)).json().reports.length, 6);
  assert.equal((await call('extensions/activate', { ...input, generation: initial.selection.generation })).statusCode, 409);
  assert.equal((await call('extensions/approve', { ...input, evidenceId: state.evidence.id, passed: true })).statusCode, 400);
  state = (await call('extensions/approve', { ...input, evidenceId: state.evidence.id })).json();
  assert.equal(state.approved, true);
  const approvedId = state.evidence.id;
  state = (await call('extensions/simulate', input)).json();
  assert.notEqual(state.evidence.id, approvedId);
  assert.equal(state.approvedEvidenceId, approvedId);
  assert.equal((await call(`extensions/evidence/${approvedId}`)).json().id, approvedId);
  state = (await call('extensions/approve', { ...input, evidenceId: state.evidence.id })).json();
  assert.equal(state.approvedEvidenceId, state.evidence.id);
  const requests = await Promise.all([call('extensions/activate', { ...input, generation: 1 }), call('extensions/disable', { generation: 1 })]);
  assert.deepEqual(requests.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal((await call('extensions/history?before=-1')).statusCode, 400);
  assert.equal((await call('extensions/history?owner=leo')).statusCode, 400);
  const proofId = approvedId;
  const prior = { ...auth }, switched = await call('session', { userId: 'leo' });
  auth = { cookie: switched.headers['set-cookie'].split(';')[0], 'x-session-context': switched.json().contextToken };
  assert.equal((await call(`extensions/evidence/${proofId}`)).statusCode, 404);
  assert.equal((await call('extensions/rollback', { revisionId: initial.selection.revision.id, generation: 1 })).statusCode, 404);
  assert.equal((await call('extensions', undefined, prior)).statusCode, 401);
  assert.equal((await call('extensions')).json().selection.generation, 1);
  db.prepare("UPDATE extension_revisions SET identity=? WHERE owner_id='leo'").run(JSON.stringify({ invalid: 'x'.repeat(263000) }));
  assert.equal((await call('extensions')).statusCode, 413, 'Oversized state is rejected rather than silently truncated');
});

test('authored source and independent suites create immutable revisions; only exact passing evidence can approve or activate', async t => {
  const { db, call, login } = await apiHarness(t);
  await login();
  const selected = (await call('extensions')).json().selection;
  const compiled = await call('extensions/compile', { source: 'synthetic qualification source', label: 'Manual check', draftVersion: 0 });
  assert.equal(compiled.statusCode, 200);
  let state = compiled.json();
  const sourceRevision = state.draft.id;
  assert.equal(state.draft.kind, 'authored');
  assert.equal(state.draft.suiteDigest, null);
  assert.equal(state.draftVersion, 1);
  assert.equal((await call('extensions/revisions/' + sourceRevision)).json().cases.length, 0);
  assert.equal((await call('extensions/simulate', { revisionId: sourceRevision, draftVersion: 1 })).statusCode, 409);

  const original = JSON.parse(validCase());
  original.expect.outcome.result.classification = 'PENDING';
  const wrong = JSON.stringify(original);
  const proposed = await call('extensions/scenarios', { revisionId: sourceRevision, cases: [wrong], draftVersion: 1 });
  assert.equal(proposed.statusCode, 200);
  state = proposed.json();
  const wrongRevision = state.draft.id;
  assert.notEqual(wrongRevision, sourceRevision);
  assert.notEqual(state.suiteDigest, null);
  assert.equal(state.draftVersion, 2);
  assert.equal((await call('extensions/revisions/' + sourceRevision)).json().cases.length, 0);
  const originalBytes = db.prepare('SELECT source,artifact FROM extension_authored WHERE revision_id=?').get(sourceRevision);
  const changedBytes = db.prepare('SELECT source,artifact,suite FROM extension_authored WHERE revision_id=?').get(wrongRevision);
  assert.deepEqual(Buffer.from(changedBytes.source), Buffer.from(originalBytes.source));
  assert.deepEqual(Buffer.from(changedBytes.artifact), Buffer.from(originalBytes.artifact));
  assert.equal(changedBytes.suite, JSON.stringify([wrong]));
  const failed = await call('extensions/simulate', { revisionId: wrongRevision, draftVersion: 2 });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().evidence.passed, false);
  assert.equal((await call('extensions/approve', { revisionId: wrongRevision, draftVersion: 2, evidenceId: failed.json().evidence.id })).statusCode, 409);
  assert.equal((await call('extensions')).json().selection.revision.id, selected.revision.id, 'Saving or simulating a draft does not change active advice');

  const proposals = await Promise.all([
    call('extensions/scenarios', { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 }),
    call('extensions/scenarios', { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 }),
  ]);
  assert.deepEqual(proposals.map(response => response.statusCode).sort(), [200, 409]);
  const corrected = proposals.find(response => response.statusCode === 200);
  assert.ok(corrected);
  state = corrected.json();
  const correctedRevision = state.draft.id;
  assert.notEqual(correctedRevision, wrongRevision);
  assert.equal(state.draftVersion, 3);
  assert.equal((await call('extensions/scenarios', { revisionId: wrongRevision, cases: [validCase()], draftVersion: 2 })).statusCode, 409);
  state = (await call('extensions/simulate', { revisionId: correctedRevision, draftVersion: 3 })).json();
  assert.equal(state.evidence.passed, true);
  state = (await call('extensions/approve', { revisionId: correctedRevision, draftVersion: 3, evidenceId: state.evidence.id })).json();
  assert.equal(state.approved, true);
  assert.equal(state.selection.revision.id, selected.revision.id);
  const active = await call('extensions/activate', { revisionId: correctedRevision, draftVersion: 3, generation: state.selection.generation });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().selection.revision.id, correctedRevision);
});

test('authored API keeps owner and artifact authority host-bound and rejects malformed scenario strings', async t => {
  const { call, login } = await apiHarness(t);
  await login();
  assert.equal((await call('extensions/compile', { source: 'synthetic', draftVersion: 0, owner: 'leo' })).statusCode, 400);
  assert.equal((await call('extensions/compile', { source: 'synthetic', draftVersion: 0, artifact: 'forged', pins: {}, templateId: 'attention' })).statusCode, 400);
  assert.equal((await call('extensions/compile', { source: '', draftVersion: 0 })).statusCode, 400);
  assert.equal((await call('extensions/compile', { source: 'x'.repeat(65537), draftVersion: 0 })).statusCode, 400);
  const compiled = await call('extensions/compile', { source: 'synthetic', draftVersion: 0 });
  const revisionId = compiled.json().draft.id;
  assert.equal((await call('extensions/revisions/' + revisionId, undefined, { 'x-session-context': 'wrong' })).statusCode, 401);
  await login('leo');
  assert.equal((await call('extensions/revisions/' + revisionId)).statusCode, 404);
  await login('maya');
  const duplicateKey = validCase().replace('"id":"open"', '"id":"open","id":"duplicate"');
  const badCases = ['', '{', duplicateKey, '[]'];
  for (const value of badCases) {
    const response = await call('extensions/scenarios', { revisionId, cases: [value], draftVersion: 1 });
    assert.ok([400, 409].includes(response.statusCode), `rejected case ${JSON.stringify(value)}`);
    assert.equal((await call('extensions')).json().draft.id, revisionId);
  }
  assert.equal((await call('extensions/scenarios', { revisionId, cases: [], draftVersion: 1 })).statusCode, 400);
  assert.equal((await call('extensions/scenarios', { revisionId, cases: [validCase()], draftVersion: 1, artifact: 'forged' })).statusCode, 400);
  const oversized = 'x'.repeat(65537);
  assert.equal((await call('extensions/scenarios', { revisionId, cases: [oversized], draftVersion: 1 })).statusCode, 400);
  assert.equal((await call('extensions/scenarios', { revisionId, cases: ['x'.repeat(45000), 'y'.repeat(45000), 'z'.repeat(45000)], draftVersion: 1 })).statusCode, 413);
});

test('compile diagnostics and concurrent/stale or revoked async completions never persist source revisions', async t => {
  let releases = [];
  let diagnostic = false;
  let expectedEntries = 2, entered;
  let ready = new Promise(resolve => { entered = resolve; });
  const compiler = { compile: async () => {
    if (diagnostic) return { artifact: null, diagnostics: [{ code: 'PARSE_ERROR', path: '/steps/0' }] };
    await new Promise(resolve => { releases.push(resolve); if (releases.length === expectedEntries) entered(); });
    return { artifact: loadCatalog().find(item => item.id === 'attention').artifactBytes, diagnostics: [] };
  } };
  const { db, call, login, logout, setAuth } = await apiHarness(t, compiler);
  await login();
  const first = call('extensions/compile', { source: 'first', draftVersion: 0 });
  const second = call('extensions/compile', { source: 'second', draftVersion: 0 });
  await ready;
  releases.splice(0).forEach(resolve => resolve());
  const concurrent = await Promise.all([first, second]);
  assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='maya'").get().n, 1);

  diagnostic = true;
  const current = (await call('extensions')).json();
  const rejected = await call('extensions/compile', { source: 'invalid', draftVersion: current.draftVersion });
  assert.equal(rejected.statusCode, 422);
  assert.deepEqual(rejected.json().diagnostics, [{ code: 'PARSE_ERROR', path: '/steps/0' }]);
  assert.equal((await call('extensions')).json().revisionId, current.revisionId);

  diagnostic = false;
  expectedEntries = 1; ready = new Promise(resolve => { entered = resolve; });
  const pending = call('extensions/compile', { source: 'revoked session', draftVersion: current.draftVersion });
  await ready;
  assert.equal((await logout()).statusCode, 200);
  setAuth({});
  const replacement = await login('leo');
  assert.equal(replacement.statusCode, 200);
  releases.splice(0).forEach(resolve => resolve());
  assert.equal((await pending).statusCode, 401);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='maya'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='leo'").get().n, 0);
});
