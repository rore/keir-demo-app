import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { AppError, openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createLifecycle, simulationCases } from '../src/extension-lifecycle.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';

function itemId(lifecycle, owner) {
  const items = lifecycle.collection(owner).items;
  assert.equal(items.length, 1, 'Fixture must have exactly one explicitly scoped extension.');
  return items[0].extension.id;
}

function extensionPath(db, suffix = '', owner = 'maya') {
  const rows = db.prepare('SELECT id FROM extensions WHERE owner_id=?').all(owner);
  assert.equal(rows.length, 1, 'Use the fixture owner’s explicit legacy extension.');
  return 'extensions/' + rows[0].id + (suffix ? '/' + suffix : '');
}

const source = readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8');
const artifact = readFileSync(new URL('../extensions/task-read/maya.json', import.meta.url));
const compiler = { compile: async () => ({ artifact, diagnostics: [] }) };
const lease = sessionId => ({ sessionId, current: () => true });
function input(db, operationId, overrides = {}, owner = 'maya') {
  const rows = db.prepare('SELECT * FROM extensions WHERE owner_id=?').all(owner);
  assert.equal(rows.length, 1, 'The fixture has one known legacy extension per owner.');
  const extension = rows[0], selection = db.prepare('SELECT * FROM extension_selections WHERE owner_id=?').get(owner);
  const target = overrides.conversationId ? { kind: 'resume', extensionId: extension.id }
    : { kind: 'revise', extensionId: extension.id, baseRevisionId: extension.draft_revision_id ?? selection.revision_id, selectionGeneration: selection.generation };
  return { conversationId: null, operationId, text: 'Help with task advice.', expectedVersion: 0, expectedDraftVersion: 0, target, ...overrides };
}
const configFor = (provider = 'openai', cap = '3') => readAuthoringConfig({ KEIR_AI_PROVIDER: provider,
  KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5', KEIR_AI_MAX_USD: cap,
  OPENAI_API_KEY: 'synthetic-secret-key', ANTHROPIC_API_KEY: 'synthetic-secret-key' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rowState = db => JSON.parse(db.prepare('SELECT state FROM authoring_conversations ORDER BY rowid DESC LIMIT 1').get().state);
const reserved = db => db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
function removeFixture(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
function assertDto(value) {
  keys(value, ['id', 'extensionId', 'purpose', 'version', 'status', 'runId', 'operation', 'messages', 'code', 'review', 'draft', 'selection']);
  keys(value.operation, ['id', 'runId', 'version']);
  keys(value.draft, ['revisionId', 'draftVersion', 'suiteDigest']);
  keys(value.selection, ['revisionId', 'generation']);
  for (const message of value.messages) keys(message, ['id', 'role', 'text', 'kind']);
  if (value.review) keys(value.review, ['revisionId', 'draftVersion', 'suiteDigest', 'evidenceId', 'eligible']);
  const text = JSON.stringify(value);
  for (const privateValue of ['synthetic-secret-key', 'private-reasoning', 'opaque-signature', 'authorization', 'continuation', 'sourceJson'])
    assert.equal(text.includes(privateValue), false, privateValue + ' must remain private');
}
function wire(provider, choose) {
  const requests = [];
  return { requests, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), index = requests.length;
    requests.push({ url, body });
    assert.equal(init.redirect, 'error');
    assert.equal(body.tools.some(tool => /approve|activate|select/.test(tool.name)), false);
    const step = await choose(body, index);
    const call = step?.name ? { id: 'call-' + index, ...step } : null;
    const raw = provider === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning', id: 'reason-' + index, encrypted_content: 'private-reasoning', summary: [] },
        ...(call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step?.text ?? 'Ready.' }] }])], usage: { input_tokens: 10, output_tokens: 5 } }
      : { stop_reason: call ? 'tool_use' : 'end_turn', content: [{ type: 'thinking', thinking: 'private-reasoning', signature: 'opaque-signature' },
        ...(call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] : [{ type: 'text', text: step?.text ?? 'Ready.' }])], usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } });
  } };
}
function lastTool(provider, body) {
  const result = provider === 'openai' ? body.input.filter(item => item.type === 'function_call_output').at(-1)?.output
    : body.messages.filter(item => item.role === 'user').at(-1)?.content.find(item => item.type === 'tool_result')?.content;
  return result ? JSON.parse(result) : null;
}
async function api(t, authoring, options = {}) {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin, compiler, ...options, authoring });
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (url, payload, headers = {}) => app.inject({ url: '/api/' + url, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  return { db, app, call, getAuth: () => ({ ...auth }), async login(userId = 'maya') {
    const bootstrap = (await call('session')).json();
    const response = await call('session', { userId }, { 'x-session-context': bootstrap.contextToken });
    assert.equal(response.statusCode, 200);
    auth = { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
  } };
}
async function settled(call, id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await call('authoring/conversations/' + id);
    assert.equal(response.statusCode, 200);
    const value = response.json();
    if (!['RUNNING', 'CANCELLING'].includes(value.status)) return value;
    await delay(10);
  }
  assert.fail('Authoring did not settle within the bounded poll.');
}
function direct(t, { path = ':memory:', ...options } = {}) {
  const db = openData(path), lifecycle = createLifecycle(db, { compiler });
  const service = createAuthoringService({ db, lifecycle, config: configFor(), ...options });
  t.after(async () => { await service.close(); db.close(); });
  return { db, lifecycle, service };
}

test('authoring API rejects foreign sessions/owners/extra fields and deduplicates exact operations with CAS', async t => {
  const fake = wire('openai', () => ({ name: 'ask_clarification', arguments: { question: 'Which independent cases should pass?' } }));
  const { db, call, login, getAuth } = await api(t, { config: configFor(), fetchImpl: fake.fetchImpl });
  assert.equal((await call('authoring')).statusCode, 401);
  await login();
  const selected = (await call(extensionPath(db))).json().selection;
  assert.equal((await call('authoring?owner=leo')).statusCode, 400);
  assert.equal((await call('authoring/turn', input(db, 'bad-origin'), { origin: 'http://invalid.local' })).statusCode, 403);
  assert.equal((await call('authoring/turn', { ...input(db, 'extra'), owner: 'leo' })).statusCode, 400);
  assert.equal((await call('authoring/turn', input(db, 'stale-draft', { expectedDraftVersion: 1 }))).statusCode, 409);
  const request = input(db, 'create');
  const response = await call('authoring/turn', request);
  assert.equal(response.statusCode, 202);
  keys(response.json(), ['operation', 'conversation']);
  const id = response.json().conversation.id;
  const current = await settled(call, id);
  assert.equal(current.status, 'AWAITING_USER'); assertDto(current);
  const duplicate = await call('authoring/turn', request);
  assert.equal(duplicate.statusCode, 202);
  assert.deepEqual(duplicate.json().operation, response.json().operation);
  assert.equal(fake.requests.length, 1);
  assert.equal((await call('authoring/turn', { ...request, text: 'Different bytes' })).statusCode, 409);
  assert.equal((await call('authoring/turn', input(db, 'stale-conversation', { conversationId: id }))).statusCode, 409);
  assert.equal((await call(`authoring/conversations/${id}/cancel`, { runId: 'wrong', expectedVersion: 1 })).statusCode, 409);
  assert.deepEqual((await call(extensionPath(db))).json().selection, selected);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  const previous = getAuth(); await login('leo');
  assert.equal((await call('authoring')).json().conversations.length, 0);
  assert.equal((await call('authoring/conversations/' + id)).statusCode, 404);
  assert.equal((await call('authoring/turn', input(db, 'foreign', { conversationId: id, expectedVersion: 1 }, 'leo'))).statusCode, 404);
  assert.equal((await call(`authoring/conversations/${id}/cancel`, { runId: current.runId, expectedVersion: 1 })).statusCode, 404);
  assert.equal((await call('authoring', undefined, previous)).statusCode, 401);
});

const java = process.env.KEIR_JAVA_BIN ?? (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
const checkedJava = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
const qualifiedJava = checkedJava.status === 0 && /version "(?:2[1-9]|[3-9][0-9])\./.test(checkedJava.stderr ?? '');
for (const provider of ['openai', 'anthropic']) test(`${provider} API repairs real pinned-JAR diagnostics, saves original cases and offers exact simulator evidence without approval`,
  { skip: !qualifiedJava && !process.env.CI }, async t => {
    assert.ok(qualifiedJava, 'Qualified Java 21 is required in CI.');
    const cases = simulationCases('pending').filter(item => item.id !== 'host-denied').map(item => '\n ' + item.bytes.toString() + '\n');
    let compiledId, scenarioId, exactEvidenceId, latestEvidenceId, callApi;
    const fake = wire(provider, async (body, index) => {
      const prior = lastTool(provider, body);
      if (index === 0) return { name: 'discover_catalog', arguments: {} };
      if (index === 1) return { name: 'compile_draft', arguments: { sourceJson: '{', expectedDraftVersion: prior.result.currentDraft.draftVersion } };
      if (index === 2) {
        assert.ok(prior.result.diagnostics.length > 0);
        for (const item of prior.result.diagnostics) keys(item, ['code', 'path']);
        assert.equal(prior.result.diagnostics[0].code, 'SYNTAX_INVALID');
        const unchanged = (await callApi(extensionPath(db))).json();
        assert.equal(unchanged.draftVersion, 0); assert.equal(unchanged.draft, null);
        return { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } };
      }
      if (index === 3) {
        compiledId = prior.result.revisionId;
        assert.equal(prior.result.draftVersion, 1); assert.equal(prior.result.suiteDigest, null);
        return { name: 'propose_scenarios', arguments: { revisionId: compiledId, cases, expectedDraftVersion: 1 } };
      }
      if (index === 4) {
        scenarioId = prior.result.revisionId;
        assert.notEqual(scenarioId, compiledId);
        return { name: 'simulate_draft', arguments: { revisionId: scenarioId, expectedDraftVersion: 2 } };
      }
      assert.equal(index, 5); assert.equal(prior.result.revisionId, scenarioId);
      exactEvidenceId = prior.result.evidenceId;
      const repeated = await callApi(extensionPath(db, 'simulate'), { revisionId: scenarioId, draftVersion: 2 });
      assert.equal(repeated.statusCode, 200);
      latestEvidenceId = repeated.json().evidence.id;
      assert.notEqual(latestEvidenceId, exactEvidenceId);
      return { name: 'offer_review', arguments: { summary: 'Review these five independent cases. Other inputs are untested.' } };
    });
    const realCompiler = createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: java });
    const { db, call, login } = await api(t, { config: configFor(provider), fetchImpl: fake.fetchImpl }, { compiler: realCompiler });
    callApi = call;
    await login(); const selection = (await call(extensionPath(db))).json().selection;
    const response = await call('authoring/turn', input(db, 'real-compile'));
    assert.equal(response.statusCode, 202);
    const current = await settled(call, response.json().conversation.id);
    assert.equal(current.status, 'REVIEW_AVAILABLE', JSON.stringify(current)); assertDto(current);
    assert.equal(current.review.eligible, true);
    const state = (await call(extensionPath(db))).json(), review = current.review;
    assert.equal(review.revisionId, state.draft.id); assert.equal(review.draftVersion, state.draftVersion);
    assert.equal(review.suiteDigest, state.suiteDigest); assert.equal(review.evidenceId, exactEvidenceId);
    assert.equal(state.evidence.id, latestEvidenceId);
    const proof = (await call(extensionPath(db, 'evidence/' + review.evidenceId))).json();
    assert.equal(proof.revisionId, scenarioId); assert.equal(proof.passed, true);
    assert.deepEqual(proof.reports.map(item => item.report.status), Array(cases.length).fill('PASS'));
    assert.deepEqual((await call(extensionPath(db, 'revisions/' + scenarioId))).json().cases, cases);
    assert.deepEqual((await call(extensionPath(db, 'revisions/' + compiledId))).json().cases, []);
    const bytes = db.prepare('SELECT source,artifact,suite FROM extension_authored WHERE revision_id=?').get(scenarioId);
    assert.equal(Buffer.from(bytes.source).toString(), source); assert.deepEqual(Buffer.from(bytes.artifact), artifact);
    assert.equal(bytes.suite, JSON.stringify(cases));
    assert.deepEqual(state.selection, selection); assert.equal(state.approved, false);
    assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
    assert.equal(reserved(db), configFor(provider).reserveMicros * 6);
    assert.equal(rowState(db).counts.compiles, 2);
    assert.equal(rowState(db).journal.length, 12); assert.ok(rowState(db).journal.every(item => item.outcome === 'SUCCESS'));
    const changed = await call(extensionPath(db, 'draft'), { templateId: 'attention', draftVersion: 2 });
    assert.equal(changed.statusCode, 200);
    assert.equal((await call('authoring/conversations/' + current.id)).json().review.eligible, false);
  });

for (const stage of ['beforeCommit', 'afterCommit']) test(`${stage} DISPATCH fault distinguishes rollback from retained uncertain reservation`, async t => {
  let faulted = false;
  const fake = wire('openai', () => ({ text: 'Must never be dispatched.' }));
  const { db, service } = direct(t, { fetchImpl: fake.fetchImpl, checkpointFault: point => {
    if (!faulted && point.phase === 'DISPATCH' && point.stage === stage) { faulted = true; throw Error('synthetic checkpoint fault'); }
  } });
  const started = await service.turn('maya', input(db, 'fault-' + stage), lease('session'));
  const current = await service.wait('maya', started.conversation.id);
  assert.equal(current.status, 'BLOCKED'); assert.equal(current.code, 'CHECKPOINT_UNCERTAIN');
  assert.equal(fake.requests.length, 0);
  assert.equal(reserved(db), stage === 'beforeCommit' ? 0 : configFor().reserveMicros);
  const state = rowState(db);
  assert.equal(state.usage.reservedMicros, reserved(db));
  assert.equal(state.journal.length, stage === 'beforeCommit' ? 0 : 1);
  if (stage === 'afterCommit') assert.equal(state.journal[0].outcome, 'UNKNOWN');
});

for (const [provider, cap] of [['openai', '0.319488'], ['anthropic', '0.077824']]) test(`${provider} concurrent owners share the durable operator allowance rather than per-conversation credit`, async t => {
  const hold = deferred(), entered = deferred();
  t.after(() => hold.resolve());
  const fake = wire(provider, async () => { entered.resolve(); await hold.promise; return { text: 'Finished.' }; });
  const config = configFor(provider, cap);
  const { db, service } = direct(t, { config, fetchImpl: fake.fetchImpl });
  const first = await service.turn('maya', input(db, 'first-owner'), lease('maya-session'));
  await entered.promise;
  const second = await service.turn('leo', input(db, 'second-owner', {}, 'leo'), lease('leo-session'));
  const blocked = await service.wait('leo', second.conversation.id);
  assert.equal(blocked.code, 'SPEND_LIMIT'); assert.equal(fake.requests.length, 1);
  assert.equal(reserved(db), config.reserveMicros);
  hold.resolve(); assert.equal((await service.wait('maya', first.conversation.id)).status, 'IDLE');
  assert.equal(reserved(db), config.reserveMicros);
});

test('file restart never replays interrupted work; a new explicit revision conversation uses current B', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-restart-')), path = join(directory, 'app.sqlite');
  let db = openData(path), lifecycle = createLifecycle(db, { compiler });
  const fake = wire('anthropic', () => ({ name: 'ask_clarification', arguments: { question: 'Confirm the current draft.' } }));
  let service = createAuthoringService({ db, lifecycle, config: configFor('anthropic'), fetchImpl: fake.fetchImpl });
  t.after(async () => { await service.close(); db.close(); removeFixture(directory); });
  const initialSelection = lifecycle.state('maya', itemId(lifecycle, 'maya')).selection;
  const first = await service.turn('maya', input(db, 'before-restart'), lease('old-session'));
  const saved = await service.wait('maya', first.conversation.id);
  await service.close();
  const currentB = lifecycle.load('maya', { extensionId: itemId(lifecycle, 'maya'), templateId: 'attention', draftVersion: 0 }, () => {});
  const state = rowState(db);
  state.status = 'RUNNING'; state.inFlight = { ordinal: 3, kind: 'provider' };
  state.dispatchOrdinal = 3; state.checkpoint = { phase: 'DISPATCH', ...state.inFlight };
  state.counts.calls++; state.usage.reservedMicros += configFor('anthropic').reserveMicros;
  state.runLedger.ordinal = 3; state.runLedger.reserved += configFor('anthropic').reserveMicros;
  state.journal.push({ runId: saved.runId, ordinal: 3, kind: 'provider', reservedMicros: configFor('anthropic').reserveMicros });
  db.prepare('UPDATE authoring_budget SET reserved_micros=reserved_micros+?').run(configFor('anthropic').reserveMicros);
  db.prepare("UPDATE authoring_conversations SET status='RUNNING',state=? WHERE id=?").run(JSON.stringify(state), saved.id);
  const held = reserved(db); db.close();
  db = openData(path); lifecycle = createLifecycle(db, { compiler });
  service = createAuthoringService({ db, lifecycle, config: configFor('anthropic'), fetchImpl: fake.fetchImpl });
  const recovered = service.read('maya', saved.id);
  assert.equal(recovered.status, 'INTERRUPTED'); assert.equal(recovered.code, 'RUN_INTERRUPTED');
  assert.equal(recovered.draft.revisionId, saved.draft.revisionId); assert.equal(recovered.draft.draftVersion, saved.draft.draftVersion); assert.equal(recovered.review, null);
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).revisionId, currentB.revisionId);
  assert.equal(rowState(db).journal.at(-1).outcome, 'UNKNOWN');
  assert.equal(fake.requests.length, 1); assert.equal(reserved(db), held);
  await assert.rejects(service.turn('maya', input(db, 'stale-recovery', { conversationId: saved.id, expectedVersion: 1 }), lease('new-session')), { code: 'STALE_DRAFT' });
  await assert.rejects(service.turn('maya', input(db, 'same-conversation-cannot-rebase', { conversationId: saved.id, expectedVersion: 1, expectedDraftVersion: 1 }), lease('new-session')), { code: 'STALE_DRAFT' });
  const retained = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(saved.id).state);
  const continued = await service.turn('maya', input(db, 'explicit-recovery', { expectedDraftVersion: 1 }), lease('new-session'));
  assert.notEqual(continued.conversation.id, saved.id);
  const result = await service.wait('maya', continued.conversation.id);
  assert.equal(result.status, 'AWAITING_USER'); assert.equal(result.version, 1); assert.equal(fake.requests.length, 2);
  assert.equal(result.draft.revisionId, currentB.revisionId);
  assert.deepEqual(JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(saved.id).state), retained);
  assert.equal(reserved(db), held + configFor('anthropic').reserveMicros);
  assert.equal(fake.requests[1].body.messages.length, 1);
  assert.equal(fake.requests[1].body.messages[0].content.some(item => item.type === 'tool_result'), false);
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, initialSelection);
});

test('cancel remains CANCELLING and blocks replacement until an ignoring compiler settles; late output cannot save', async t => {
  const entered = deferred(), release = deferred();
  const db = openData(':memory:');
  const lifecycle = createLifecycle(db, { compiler: { compile: async () => { entered.resolve(); await release.promise; return { artifact, diagnostics: [] }; } } });
  const fake = wire('openai', () => ({ name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } }));
  const service = createAuthoringService({ db, lifecycle, config: configFor(), fetchImpl: fake.fetchImpl });
  t.after(async () => { release.resolve(); await service.close(); db.close(); });
  const initial = lifecycle.state('maya', itemId(lifecycle, 'maya'));
  const started = await service.turn('maya', input(db, 'cancel-compile'), lease('session'));
  await entered.promise;
  const current = started.conversation;
  assert.equal(service.cancel('maya', current.id, { runId: current.runId, expectedVersion: current.version }, lease('session')).status, 'CANCELLING');
  await tick(); await tick();
  assert.equal(service.read('maya', current.id).status, 'CANCELLING');
  assert.throws(() => service.configure(configFor(), () => assert.fail('busy compiler must not persist settings')), { code: 'AI_BUSY' });
  await assert.rejects(service.turn('maya', input(db, 'replacement'), lease('session')), { code: 'AI_BUSY' });
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draftVersion, initial.draftVersion);
  release.resolve();
  const cancelled = await service.wait('maya', current.id);
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.code, 'CANCELLED');
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, initial.selection);
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draftVersion, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 0);
  assert.equal(fake.requests.length, 1); assert.equal(reserved(db), configFor().reserveMicros);
});

test('cancel retains the run until an abort-insensitive fetch and response cancellation both settle', async t => {
  const entered = deferred(), fetched = deferred(), cancelEntered = deferred(), cancelled = deferred();
  t.after(() => { fetched.resolve(); cancelled.resolve(); });
  let requests = 0;
  const fetchImpl = async () => {
    requests++; entered.resolve(); await fetched.promise;
    return new Response(new ReadableStream({ cancel() { cancelEntered.resolve(); return cancelled.promise; } }),
      { headers: { 'content-type': 'application/json' } });
  };
  const { db, service } = direct(t, { fetchImpl });
  const started = await service.turn('maya', input(db, 'cancel-fetch'), lease('session'));
  await entered.promise;
  const { id, runId, version } = started.conversation;
  service.cancel('maya', id, { runId, expectedVersion: version }, lease('session'));
  await tick(); await tick();
  assert.equal(service.read('maya', id).status, 'CANCELLING');
  await assert.rejects(service.turn('maya', input(db, 'during-fetch'), lease('session')), { code: 'AI_BUSY' });
  assert.throws(() => service.configure(configFor(), () => assert.fail('busy fetch must not persist settings')), { code: 'AI_BUSY' });
  fetched.resolve(); await cancelEntered.promise;
  assert.equal(service.read('maya', id).status, 'CANCELLING');
  await assert.rejects(service.turn('maya', input(db, 'during-body-cancel'), lease('session')), { code: 'AI_BUSY' });
  assert.throws(() => service.configure(configFor(), () => assert.fail('pending response cancellation must not persist settings')), { code: 'AI_BUSY' });
  cancelled.resolve();
  const result = await service.wait('maya', id);
  assert.equal(result.status, 'CANCELLED'); assert.equal(requests, 1);
  assert.equal(reserved(db), configFor().reserveMicros);
});

test('independent wrong expectation remains byte-exact and review-ineligible without automatic repair or approval', async t => {
  const value = JSON.parse(simulationCases('pending')[0].bytes.toString());
  value.expect.outcome.result.classification = 'DONE';
  value.expect.consumption.code = 'DONE';
  const original = '\n' + JSON.stringify(value, null, 2) + '\n';
  const fake = wire('openai', (body, index) => {
    const prior = lastTool('openai', body);
    if (index === 0) return { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } };
    if (index === 1) return { name: 'propose_scenarios', arguments: { revisionId: prior.result.revisionId, cases: [original], expectedDraftVersion: 1 } };
    if (index === 2) return { name: 'simulate_draft', arguments: { revisionId: prior.result.revisionId, expectedDraftVersion: 2 } };
    assert.equal(index, 3);
    return { name: 'offer_review', arguments: { summary: 'The independent expected result did not pass. Review the mismatch.' } };
  });
  const { db, service, lifecycle } = direct(t, { fetchImpl: fake.fetchImpl });
  const selection = lifecycle.state('maya', itemId(lifecycle, 'maya')).selection;
  const started = await service.turn('maya', input(db, 'wrong-expectation'), lease('session'));
  const result = await service.wait('maya', started.conversation.id);
  assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.eligible, false);
  const proof = lifecycle.evidence('maya', result.review.evidenceId, itemId(lifecycle, 'maya'));
  assert.equal(proof.passed, false); assert.equal(proof.reports[0].report.status, 'MISMATCH');
  assert.deepEqual(lifecycle.source('maya', result.review.revisionId, itemId(lifecycle, 'maya')).cases, [original]);
  assert.equal(fake.requests.length, 4); assert.equal(rowState(db).counts.compiles, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, selection);
});

test('oversized terminal checkpoint settles BLOCKED with retained credit and allows explicit continuation', async t => {
  const config = configFor(); let calls = 0, resultSaved = false, resultRow;
  const { db, service } = direct(t, { providerFactory: () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      return { continuation: { provider: 'openai', items: calls === 1 ? ['x'.repeat(260825)] : [] }, calls: [],
        text: calls === 1 ? 'y'.repeat(200) : 'Ready.', usage: { inputTokens: 1, outputTokens: 1 } };
    } }), checkpointFault: point => {
      if (point.phase === 'RESULT' && point.stage === 'afterCommit' && calls === 1) {
        resultSaved = true; resultRow = db.prepare('SELECT * FROM authoring_conversations').get();
      }
    } });
  const started = await service.turn('maya', input(db, 'large'), lease('session'));
  const blocked = await service.wait('maya', started.conversation.id);
  assert.equal(resultSaved, true, 'The provider result fits; only terminal state exceeds the byte limit.');
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.code, 'BYTE_LIMIT');
  assert.equal(reserved(db), config.reserveMicros);
  assert.equal(rowState(db).continuation, undefined); assert.equal(rowState(db).pending, undefined);
  const continued = await service.turn('maya', input(db, 'next', { conversationId: blocked.id, expectedVersion: 1 }), lease('session'));
  assert.equal((await service.wait('maya', continued.conversation.id)).status, 'IDLE');
  assert.equal(calls, 2); assert.equal(reserved(db), config.reserveMicros * 2);
  await service.close();
  db.prepare('UPDATE authoring_conversations SET version=?,run_id=?,status=?,cancel_requested=?,state=?,operations=?,view=? WHERE id=?')
    .run(resultRow.version, resultRow.run_id, resultRow.status, resultRow.cancel_requested, resultRow.state, resultRow.operations, resultRow.view, resultRow.id);
  const recovered = createAuthoringService({ db, lifecycle: createLifecycle(db, { compiler }), config,
    providerFactory: () => { assert.fail('Startup must not replay the provider.'); } });
  try {
    const interrupted = recovered.read('maya', resultRow.id);
    assert.equal(interrupted.status, 'INTERRUPTED'); assert.equal(interrupted.code, 'RUN_INTERRUPTED');
    assert.equal(rowState(db).continuation, undefined); assert.equal(rowState(db).pending, undefined);
    assert.equal(rowState(db).evidenceHandle, null); assert.equal(calls, 2);
    assert.equal(reserved(db), config.reserveMicros * 2);
  } finally { await recovered.close(); }
});

for (const mutation of ['source', 'cases']) test(`${mutation} commit survives lost tool-result checkpoint; old chat retains A and a new revision conversation uses B`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-result-')), path = join(directory, 'app.sqlite');
  let db = openData(path), lifecycle = createLifecycle(db, { compiler }), service;
  t.after(async () => { await service?.close(); db.close(); removeFixture(directory); });
  const selectedA = lifecycle.state('maya', itemId(lifecycle, 'maya')).selection;
  const initial = mutation === 'source' ? lifecycle.load('maya', { extensionId: itemId(lifecycle, 'maya'), templateId: 'pending', draftVersion: 0 }, () => {})
    : await lifecycle.compile('maya', { extensionId: itemId(lifecycle, 'maya'), source, draftVersion: 0 }, () => {});
  const initialSource = lifecycle.source('maya', initial.revisionId, initial.extension.id);
  const fake = wire('openai', (body, index) => {
    if (index === 0) return mutation === 'source'
      ? { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 1 } }
      : { name: 'propose_scenarios', arguments: { revisionId: initial.revisionId, cases: [simulationCases('pending')[0].bytes.toString()], expectedDraftVersion: 1 } };
    assert.equal(body.input.length, 1, 'Explicit recovery starts a fresh native chain using current host handles.');
    return { name: 'ask_clarification', arguments: { question: 'Confirm the saved current draft.' } };
  });
  let faulted = false;
  service = createAuthoringService({ db, lifecycle, config: configFor(), fetchImpl: fake.fetchImpl, checkpointFault: point => {
    if (point.stage === 'beforeCommit' && (point.phase === 'RESULT' && point.ordinal === 2 || faulted && point.phase === 'TERMINAL')) {
      faulted = true; throw Error('synthetic lost tool result');
    }
  } });
  const started = await service.turn('maya', input(db, 'mutate', { expectedDraftVersion: 1 }), lease('old-session'));
  const stopped = await service.wait('maya', started.conversation.id);
  assert.equal(stopped.code, 'CHECKPOINT_UNCERTAIN');
  const currentB = lifecycle.state('maya', itemId(lifecycle, 'maya')), beforeRestart = rowState(db), held = reserved(db);
  assert.equal(currentB.draftVersion, 2); assert.notEqual(currentB.revisionId, initial.revisionId);
  assert.equal(beforeRestart.handles.revisionId, initial.revisionId, 'Lost result preserves the prior durable A handle.');
  assert.equal(beforeRestart.journal.at(-1).outcome, 'UNKNOWN');
  await service.close(); db.close();
  db = openData(path); lifecycle = createLifecycle(db, { compiler });
  service = createAuthoringService({ db, lifecycle, config: configFor(), fetchImpl: fake.fetchImpl });
  const recovered = service.read('maya', stopped.id);
  assert.equal(recovered.draft.revisionId, initial.revisionId); assert.equal(recovered.draft.draftVersion, 1);
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).revisionId, currentB.revisionId);
  assert.equal(fake.requests.length, 1); assert.equal(reserved(db), held);
  await assert.rejects(service.turn('maya', input(db, 'stale', { conversationId: stopped.id, expectedVersion: 1, expectedDraftVersion: 1 }), lease('new-session')), { code: 'STALE_DRAFT' });
  await assert.rejects(service.turn('maya', input(db, 'no-silent-rebase', { conversationId: stopped.id, expectedVersion: 1, expectedDraftVersion: 2 }), lease('new-session')), { code: 'STALE_DRAFT' });
  const retained = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(stopped.id).state);
  const resumed = await service.turn('maya', input(db, 'resume', { expectedDraftVersion: 2 }), lease('new-session'));
  assert.notEqual(resumed.conversation.id, stopped.id);
  const finished = await service.wait('maya', resumed.conversation.id);
  assert.equal(finished.status, 'AWAITING_USER'); assert.equal(finished.draft.revisionId, currentB.revisionId);
  assert.deepEqual(JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(stopped.id).state), retained);
  assert.deepEqual(retained.counts, beforeRestart.counts);
  assert.deepEqual(retained.usage, beforeRestart.usage);
  assert.equal(rowState(db).counts.calls, 1); assert.equal(rowState(db).counts.tools, 1);
  assert.deepEqual(lifecycle.source('maya', initial.revisionId, initial.extension.id), initialSource);
  assert.equal(reserved(db), held + configFor().reserveMicros);
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, selectedA);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
});

for (const provider of ['openai', 'anthropic']) for (const defect of ['duplicate-key', 'missing-error-path', 'duplicate-id'])
test(`${provider} repairs ${defect} native scenario rejection without changing original expectations or limits`, async t => {
  const cases = simulationCases('pending').filter(item => item.id !== 'host-denied').map(item => '\n ' + item.bytes.toString() + '\n');
  const malformed = JSON.parse(cases[2]); delete malformed.expect.outcome.error.path;
  const invalid = defect === 'duplicate-key' ? ['{"id":"private-hostile-instruction",' + cases[0].trim().slice(1)]
    : defect === 'missing-error-path' ? [cases[0], JSON.stringify(malformed)] : [cases[0], cases[0]];
  let compiled, saved, db, service, lifecycle;
  const fake = wire(provider, (body, index) => {
    if (index === 0) return { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } };
    const prior = lastTool(provider, body);
    if (index === 1) {
      compiled = prior.result;
      return { name: 'propose_scenarios', arguments: { revisionId: compiled.revisionId, cases: invalid, expectedDraftVersion: 1 } };
    }
    if (index === 2) {
      assert.deepEqual(prior, { ok: true, result: { diagnostics: [{ code: defect === 'duplicate-id' ? 'DUPLICATE_SCENARIO_ID' : 'INVALID_SCENARIO',
        path: defect === 'duplicate-key' ? '/cases/0' : '/cases/1' }] } });
      assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draft.id, compiled.revisionId);
      assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draftVersion, 1); assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).suiteDigest, null);
      assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 1);
      assert.equal(db.prepare('SELECT suite FROM extension_authored').get().suite, null);
      assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
      assert.equal(reserved(db), configFor(provider).reserveMicros * 3);
      return { name: 'propose_scenarios', arguments: { revisionId: compiled.revisionId, cases, expectedDraftVersion: 1 } };
    }
    if (index === 3) {
      saved = prior.result; assert.equal(saved.draftVersion, 2); assert.notEqual(saved.revisionId, compiled.revisionId);
      return { name: 'simulate_draft', arguments: { revisionId: saved.revisionId, expectedDraftVersion: 2 } };
    }
    assert.equal(index, 4); assert.ok(prior.result.summary.statuses.every(status => status === 'PASS'));
    return { name: 'offer_review', arguments: { summary: 'Review the independently expected examples.' } };
  });
  ({ db, service, lifecycle } = direct(t, { config: configFor(provider), fetchImpl: fake.fetchImpl }));
  const selection = lifecycle.state('maya', itemId(lifecycle, 'maya')).selection;
  const started = await service.turn('maya', input(db, 'scenario-repair'), lease('session'));
  const finished = await service.wait('maya', started.conversation.id);
  assert.equal(finished.status, 'REVIEW_AVAILABLE'); assert.equal(finished.review.eligible, true); assertDto(finished);
  assert.deepEqual(lifecycle.source('maya', saved.revisionId, itemId(lifecycle, 'maya')).cases, cases);
  assert.equal(lifecycle.source('maya', saved.revisionId, itemId(lifecycle, 'maya')).source, source);
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draftVersion, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, selection);
  assert.deepEqual(rowState(db).counts, { calls: 5, tools: 5, compiles: 1, simulations: 1, clarifications: 0, inputs: 1 });
  assert.equal(fake.requests.length, 5); assert.equal(reserved(db), configFor(provider).reserveMicros * 5);
});

test('only allowlisted scenario admission diagnostics are repairable; other host failures stay terminal', async t => {
  const valid = { code: 'INVALID_SCENARIO', path: '/cases/0' };
  for (const [status, diagnostics, expected] of [
    [400, undefined, 'TOOL_FAILED'], [400, [{ ...valid, code: 'SETUP_ERROR' }], 'TOOL_FAILED'],
    [400, [{ ...valid, code: 'CONSUMER_ERROR' }], 'TOOL_FAILED'], [400, [{ ...valid, path: '/cases/8' }], 'TOOL_FAILED'],
    [400, [{ ...valid, path: '/private-hostile-instruction' }], 'TOOL_FAILED'], [400, [{ ...valid, message: 'private-hostile-instruction' }], 'TOOL_FAILED'],
    [400, [], 'TOOL_FAILED'], [400, [valid, valid], 'TOOL_FAILED'], [500, [valid], 'TOOL_FAILED'],
    [401, [valid], 'TOOL_FAILED'], [422, [valid], 'TOOL_FAILED'], [409, [valid], 'STALE_DRAFT'], [499, [valid], 'CANCELLED'], [429, [valid], 'AI_BUSY'],
  ]) {
    const fake = wire('openai', (body, index) => {
      if (index === 0) return { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } };
      assert.equal(index, 1);
      return { name: 'propose_scenarios', arguments: { revisionId: lastTool('openai', body).result.revisionId, cases: ['{}'], expectedDraftVersion: 1 } };
    });
    const { db, service, lifecycle } = direct(t, { fetchImpl: fake.fetchImpl });
    lifecycle.proposeScenarios = () => { throw Object.assign(new AppError(status, 'private-hostile-instruction'), { diagnostics }); };
    const started = await service.turn('maya', input(db, 'terminal-scenario'), lease('session'));
    const finished = await service.wait('maya', started.conversation.id);
    assert.equal(finished.code, expected); assert.equal(finished.status, expected === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED');
    assert.equal(JSON.stringify(finished).includes('private-hostile-instruction'), false);
    assert.equal(fake.requests.length, 2); assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).draftVersion, 1);
    assert.equal(db.prepare('SELECT suite FROM extension_authored').get().suite, null);
    assert.equal(reserved(db), configFor().reserveMicros * 2);
  }
});

test('public scenario rejection stays HTTP400 and returns only a host-constructed case diagnostic', async t => {
  const { db, call, login } = await api(t, { config: configFor() });
  await login();
  const compiled = (await call(extensionPath(db, 'compile'), { source, draftVersion: 0 })).json();
  const valid = simulationCases('pending')[0].bytes.toString();
  for (const [cases, diagnostic] of [
    [['{"id":"private-hostile-instruction",' + valid.slice(1)], { code: 'INVALID_SCENARIO', path: '/cases/0' }],
    [[valid, valid], { code: 'DUPLICATE_SCENARIO_ID', path: '/cases/1' }],
  ]) {
    const response = await call(extensionPath(db, 'scenarios'), { revisionId: compiled.draft.id, draftVersion: 1, cases });
    assert.equal(response.statusCode, 400); assert.deepEqual(response.json().diagnostics, [diagnostic]);
    assert.equal(response.body.includes('private-hostile-instruction'), false);
    assert.equal((await call(extensionPath(db))).json().draftVersion, 1);
    assert.equal(db.prepare('SELECT suite FROM extension_authored').get().suite, null);
  }
});

for (const secondLength of [8192, 6000]) test(`near-full public transcript with ${secondLength}-byte next input stays readable and never strands RUNNING`, async t => {
  const config = configFor(); let calls = 0;
  const { db, call, login } = await api(t, { config, providerFactory: () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      if (calls > 1) throw Error('synthetic provider failure');
      return { calls: [], text: 'x'.repeat(122500), usage: { inputTokens: 1, outputTokens: 1 } };
    } }) });
  await login();
  const first = await call('authoring/turn', input(db, 'near-cap'));
  assert.equal(first.statusCode, 202);
  const saved = await settled(call, first.json().conversation.id);
  assert.equal(saved.status, 'IDLE'); assert.equal(saved.messages.at(-1).text.length, 122500);
  const second = await call('authoring/turn', input(db, 'follow-up', { conversationId: saved.id, expectedVersion: 1, text: 'y'.repeat(secondLength) }));
  if (secondLength === 8192) {
    assert.ok([413, 503].includes(second.statusCode)); assert.equal(second.json().code, 'BYTE_LIMIT');
    assert.equal(calls, 1); assert.equal(reserved(db), config.reserveMicros);
    const read = await call('authoring/conversations/' + saved.id);
    assert.equal(read.statusCode, 200); assert.deepEqual(read.json(), saved);
  } else {
    assert.equal(second.statusCode, 202);
    const failed = await settled(call, saved.id);
    assert.equal(failed.status, 'BLOCKED'); assert.equal(failed.code, 'TOOL_FAILED');
    assert.equal(failed.messages[1].text.length, 122500);
    assert.equal(calls, 2); assert.equal(reserved(db), config.reserveMicros * 2);
    assert.ok(Buffer.byteLength(JSON.stringify(failed)) <= 131072); assertDto(failed);
  }
});

test('allowance below one Anthropic reservation cannot dispatch any provider request', async t => {
  const fake = wire('anthropic', () => { assert.fail('Insufficient allowance must prevent dispatch.'); });
  const { db, service } = direct(t, { config: configFor('anthropic', '0.077823'), fetchImpl: fake.fetchImpl });
  const started = await service.turn('maya', input(db, 'below-reservation'), lease('session'));
  const result = await service.wait('maya', started.conversation.id);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.code, 'SPEND_LIMIT');
  assert.equal(fake.requests.length, 0); assert.equal(reserved(db), 0);
});

test('switching session during fetch fences late tools and fresh explicit recovery inherits no native chain', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const fake = wire('anthropic', async (body, index) => {
    if (index === 0) {
      entered.resolve(); await release.promise;
      return { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 0 } };
    }
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content.some(item => item.type === 'tool_result'), false);
    return { name: 'ask_clarification', arguments: { question: 'Confirm this session intent.' } };
  });
  const { db, call, login, getAuth } = await api(t, { config: configFor('anthropic'), fetchImpl: fake.fetchImpl });
  await login('maya');
  const started = await call('authoring/turn', input(db, 'old-session'));
  assert.equal(started.statusCode, 202); await entered.promise;
  const id = started.json().conversation.id, previous = getAuth();
  await login('leo');
  assert.equal((await call('authoring/conversations/' + id)).statusCode, 404);
  assert.equal((await call('authoring', undefined, previous)).statusCode, 401);
  assert.equal((await call('authoring')).json().conversations.length, 0);
  const leo = await call('authoring/turn', input(db, 'leo-session', {}, 'leo'));
  assert.equal(leo.statusCode, 202);
  assert.equal((await settled(call, leo.json().conversation.id)).status, 'AWAITING_USER');
  release.resolve();
  const deadline = Date.now() + 5000;
  while (db.prepare('SELECT status FROM authoring_conversations WHERE id=?').get(id).status === 'CANCELLING' && Date.now() < deadline) await delay(10);
  assert.equal(db.prepare('SELECT status FROM authoring_conversations WHERE id=?').get(id).status, 'CANCELLED');
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 0);
  await login('maya');
  const recovered = (await call('authoring/conversations/' + id)).json();
  assert.equal(recovered.status, 'CANCELLED'); assert.equal(recovered.draft.draftVersion, 0);
  const continued = await call('authoring/turn', input(db, 'fresh-maya-session', { conversationId: id, expectedVersion: 1 }));
  assert.equal(continued.statusCode, 202);
  assert.equal((await settled(call, id)).status, 'AWAITING_USER'); assert.equal(fake.requests.length, 3);
});
