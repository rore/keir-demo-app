import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { AppError, openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createAuthoringProvider } from '../src/authoring-provider.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createLifecycle as lifecycleFactory } from '../src/extension-lifecycle.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { TASK_HOOK } from '../src/extension-catalog.mjs';
import { taskCustomizationFixture, compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const taskFixture = taskCustomizationFixture(), source = taskFixture.source;
let artifact;
before(async () => { artifact = (await compileTaskCustomization()).artifactBytes; });
const compiler = { compile: async () => ({ artifact, diagnostics: [] }) };
const taskCases = () => taskFixture.cases.map(text => ({ id: JSON.parse(text).id, bytes: Buffer.from(text) }));
const lifecycleDatabases = new WeakMap();
function createLifecycle(db, options) {
  const lifecycle = lifecycleFactory(db, options); lifecycleDatabases.set(lifecycle, db); return lifecycle;
}
function taskDraft(db, owner = 'maya') {
  const lifecycle = createLifecycle(db, { compiler }), operationId = 'authoring-fixture-' + owner;
  const existing = db.prepare('SELECT id FROM extensions WHERE owner_id=? AND creation_operation_id=?').get(owner, operationId);
  if (!existing) return admitTaskDraft(db, lifecycle, { owner, operationId });
  const conversation = db.prepare("SELECT c.id FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id WHERE l.extension_id=? AND l.purpose='CREATE'").get(existing.id);
  return { extensionId: existing.id, conversationId: conversation.id, state: lifecycle.state(owner, existing.id) };
}

function itemId(lifecycle, owner) {
  return taskDraft(lifecycleDatabases.get(lifecycle), owner).extensionId;
}

function extensionPath(db, suffix = '', owner = 'maya') {
  return 'extensions/' + taskDraft(db, owner).extensionId + (suffix ? '/' + suffix : '');
}

const lease = sessionId => ({ sessionId, current: () => true });
function input(db, operationId, overrides = {}, owner = 'maya') {
  const fixture = taskDraft(db, owner), extension = db.prepare('SELECT * FROM extensions WHERE id=?').get(fixture.extensionId);
  const selection = db.prepare("SELECT * FROM extension_selections WHERE owner_id=? AND hook_id='TaskCompleted'").get(owner);
  const initial = extension.draft_version === 0 && db.prepare('SELECT version FROM authoring_conversations WHERE id=?').get(fixture.conversationId).version === 0;
  const conversationId = overrides.conversationId ?? (initial ? fixture.conversationId : null);
  const target = conversationId ? { kind: 'resume', extensionId: extension.id }
    : { kind: 'revise', extensionId: extension.id, baseRevisionId: extension.draft_revision_id ?? selection.revision_id, selectionGeneration: selection.generation };
  return { conversationId, operationId, text: 'Help with this task customization.', expectedVersion: 0, expectedDraftVersion: 0, target, ...overrides };
}
const configFor = (provider = 'openai', cap = '3') => readAuthoringConfig({ KEIR_AI_PROVIDER: provider,
  KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5', KEIR_AI_MAX_USD: cap,
  OPENAI_API_KEY: 'synthetic-secret-key', ANTHROPIC_API_KEY: 'synthetic-secret-key' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rowState = db => JSON.parse(db.prepare('SELECT state FROM authoring_conversations ORDER BY rowid DESC LIMIT 1').get().state);
const dispatches = (db, id = db.prepare('SELECT id FROM authoring_conversations ORDER BY rowid DESC LIMIT 1').get().id) =>
  db.prepare('SELECT * FROM authoring_dispatches WHERE conversation_id=? ORDER BY rowid').all(id);
const reserved = db => db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
const guideFile = new URL('../vendor/customer-authoring-guide-v5.md', import.meta.url);
function substituteGuide(t, path) {
  const open = fs.openSync;
  return t.mock.method(fs, 'openSync', (file, ...options) =>
    open(String(file) === guideFile.href ? path : file, ...options));
}
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
function removeFixture(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
function assertDto(value) {
  keys(value, ['id', 'extensionId', 'purpose', 'retired', 'version', 'status', 'runId', 'operation', 'messages', 'messagesBefore', 'code', 'review', 'draft', 'selection']);
  assert.ok(value.messagesBefore === null || typeof value.messagesBefore === 'string');
  keys(value.operation, ['id', 'runId', 'version']);
  keys(value.draft, ['revisionId', 'draftVersion', 'suiteDigest']);
  keys(value.selection, ['revisionId', 'generation']);
  for (const message of value.messages) {
    keys(message, ['id', 'role', 'text', 'kind', ...(message.receipt ? ['receipt'] : [])]);
    if (message.receipt) keys(message.receipt, ['revisionId', 'draftVersion', 'suiteDigest', 'evidenceId']);
  }
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
    if (step?.name === 'compile_draft') step.arguments = { hookId: TASK_HOOK, ...step.arguments };
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

for (const provider of ['openai', 'anthropic']) test(`${provider} continues a saved item through one paginated transcript and an exact operation receipt`, async t => {
  const fake = wire(provider, () => ({ text: 'The customization can continue here.' }));
  const { db, call, login } = await api(t, { config: configFor(provider), fetchImpl: fake.fetchImpl });
  const lifecycle = createLifecycle(db, { compiler });
  const oldCreated = Date.now() + 60000;
  const old = admitTaskDraft(db, lifecycle, { name: 'Saved task rule', createdAt: oldCreated });
  const other = admitTaskDraft(db, lifecycle, { name: 'Unrelated rule' });
  const foreign = admitTaskDraft(db, lifecycle, { owner: 'leo', name: 'Foreign rule' });
  const newer = await lifecycle.compile('maya', { extensionId: old.extensionId, hookId: TASK_HOOK, source, draftVersion: old.state.draftVersion }, () => true);
  const insert = db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)');
  const prior = 'Keep the exact title and require the selected project.';
  for (let i = 1; i <= 24; i++) {
    const user = i >= 22;
    const text = i === 24 ? prior : user ? `Prior user requirement ${i} ${'x'.repeat(6000)}` : `Saved assistant message ${i}`;
    insert.run(old.conversationId, 'maya', i, 'old-' + i, JSON.stringify({ id: 'old-' + i, role: user ? 'user' : 'assistant', kind: 'text', text }));
  }
  for (const [item, owner] of [[other, 'maya'], [foreign, 'leo']])
    insert.run(item.conversationId, owner, 1, 'old-24', JSON.stringify({ id: 'old-24', role: 'user', kind: 'text', text: 'Unrelated private intent' }));
  await login();
  const itemQuery = 'extensionId=' + old.extensionId;
  const listPath = 'authoring?' + itemQuery;
  const pagePath = 'authoring/transcript?' + itemQuery;
  const before = (await call(listPath)).json();
  assert.equal(before.current, null);
  assert.equal(before.transcript.messages.length, 20);
  assert.ok(before.transcript.messages.every(message => message.conversationId === old.conversationId));
  const anchor = before.transcript.next;
  assert.ok(anchor);
  assert.equal((await call('authoring/transcript?extensionId=' + other.extensionId + '&before=' + anchor)).statusCode, 400);
  const foreignAnchor = JSON.parse(Buffer.from(anchor, 'base64url').toString('utf8'));
  foreignAnchor.conversationId = other.conversationId;
  const forged = Buffer.from(JSON.stringify(foreignAnchor)).toString('base64url');
  assert.equal((await call(pagePath + '&before=' + forged)).statusCode, 400);
  assert.equal((await call('authoring/transcript?extensionId=' + foreign.extensionId)).statusCode, 404);
  assert.equal((await call('authoring/transcript?extensionId=' + foreign.extensionId + '&before=' + anchor)).statusCode, 404);
  assert.equal(fake.requests.length, 0);
  assert.equal(reserved(db), 0);

  const request = { conversationId: null, operationId: 'continue-saved-item', text: '  Continue this change 🌱  ',
    expectedVersion: 0, expectedDraftVersion: newer.draftVersion, target: { kind: 'revise', extensionId: old.extensionId,
      baseRevisionId: newer.draft.id, selectionGeneration: newer.selection.generation } };
  const accepted = await call('authoring/turn', request);
  assert.equal(accepted.statusCode, 202, accepted.body);
  const current = accepted.json().conversation;
  assert.notEqual(current.id, old.conversationId);
  assert.equal(current.extensionId, old.extensionId);
  assert.ok(db.prepare('SELECT created_at FROM authoring_conversations WHERE id=?').get(current.id).created_at > oldCreated);
  await settled(call, current.id);
  assert.equal(fake.requests.length, 1);
  const body = fake.requests[0].body;
  const inputText = provider === 'openai' ? body.input.at(-1).content : body.messages.at(-1).content.at(-1).text;
  const envelope = JSON.parse(inputText);
  assert.equal(envelope.currentUserMessage, request.text);
  assert.equal(envelope.previousUserMessagesTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope.previousUserMessages)) <= 8192);
  assert.ok(!envelope.previousUserMessages.includes(request.text));
  assert.match(inputText, /Keep the exact title and require the selected project/);
  assert.doesNotMatch(inputText, /Saved assistant message|Unrelated private intent|Prior user requirement 22/);
  const recovery = await call('authoring/recover', request);
  assert.equal(recovery.statusCode, 200);
  assert.deepEqual(recovery.json().operation, accepted.json().operation);
  assert.equal(recovery.json().conversation.messages.find(message => message.id === request.operationId).text, request.text);
  assert.equal((await call('authoring/recover', { ...request, text: request.text.trim() })).statusCode, 409);

  const reopened = (await call(listPath)).json();
  assert.equal(reopened.current.id, current.id);
  assert.deepEqual(reopened.transcript.messages.slice(-2).map(message => [message.conversationId, message.text]),
    [[current.id, request.text], [current.id, 'The customization can continue here.']]);
  const remaining = (await call(pagePath + '&before=' + reopened.transcript.next)).json();
  const all = [...remaining.messages, ...reopened.transcript.messages];
  assert.equal(all.length, 26);
  assert.equal(new Set(all.map(message => `${message.conversationId}:${message.id}`)).size, 26);
  assert.equal(remaining.next, null);
  assert.equal((await call(pagePath + '&before=' + anchor)).json().messages.length, 4, 'a prior page anchor remains valid after append');
  assert.deepEqual(lifecycle.state('maya', old.extensionId), newer);
  assert.equal(fake.requests.length, 1);
  await login('leo');
  assert.equal((await call(pagePath + '&before=' + anchor)).statusCode, 404);
  assert.equal((await call('authoring/transcript?extensionId=' + foreign.extensionId + '&before=' + anchor)).statusCode, 400);
});

test('a fresh segment rechecks selection at admission and retains exact earlier recovery after handoff', async t => {
  let fixtureDb, changeSelection = true, calls = 0;
  const { db, lifecycle, service } = direct(t, { providerFactory: config => {
    if (changeSelection) fixtureDb.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskCompleted'").run();
    return { ...config, async complete() {
      calls++;
      return { calls: [], text: 'Ready.', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
  } });
  fixtureDb = db;
  const { extensionId, conversationId } = taskDraft(db);
  const before = lifecycle.state('maya', extensionId);
  const request = { conversationId: null, operationId: 'fresh-segment', text: 'Keep working on this item.',
    expectedVersion: 0, expectedDraftVersion: before.draftVersion, target: { kind: 'revise', extensionId,
      baseRevisionId: null, selectionGeneration: before.selection.generation } };
  await assert.rejects(service.turn('maya', request, lease('fresh-segment-test')), { code: 'STALE_DRAFT' });
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 1);
  assert.equal(reserved(db), 0);

  changeSelection = false;
  const earlier = { ...request, conversationId, operationId: 'earlier-segment', target: { kind: 'resume', extensionId } };
  const earlierReceipt = await service.turn('maya', earlier, lease('fresh-segment-test'));
  const earlierSettled = await service.wait('maya', conversationId);
  const current = { ...request, target: { ...request.target, selectionGeneration: lifecycle.state('maya', extensionId).selection.generation } };
  const newReceipt = await service.turn('maya', current, lease('fresh-segment-test'));
  const newId = newReceipt.conversation.id;
  await service.wait('maya', newId);
  await assert.rejects(service.turn('maya', { ...earlier, operationId: 'too-old', expectedVersion: earlierSettled.version }, lease('fresh-segment-test')),
    { code: 'STALE_CONVERSATION' });
  assert.deepEqual(service.recover('maya', earlier).operation, earlierReceipt.operation);
  assert.deepEqual((await service.turn('maya', earlier, lease('fresh-segment-test'))).operation, earlierReceipt.operation);
  assert.equal(service.list('maya', extensionId).current.id, newId);
  assert.equal(calls, 2);
});

test('the linked authoring response budgets large transcripts and deleted items cannot page them', async t => {
  const fake = wire('openai', () => ({ text: 'Unexpected provider request.' }));
  const { db, call, login } = await api(t, { config: configFor(), fetchImpl: fake.fetchImpl });
  const { extensionId, conversationId, state } = taskDraft(db);
  const insert = db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 2; i++) {
    const message = { id: 'large-' + i, role: 'assistant', kind: 'text', text: 'x'.repeat(131000) };
    insert.run(conversationId, 'maya', i, message.id, JSON.stringify(message));
  }
  await login();
  const query = '?extensionId=' + extensionId;
  const result = await call('authoring' + query);
  assert.equal(result.statusCode, 200);
  assert.ok(Buffer.byteLength(result.body) <= 262144);
  const { current, transcript } = result.json();
  assert.equal(current.id, conversationId);
  assert.deepEqual(transcript.messages.map(message => message.id), ['large-2']);
  const earlier = 'authoring/transcript' + query + '&before=' + transcript.next;
  assert.deepEqual((await call(earlier)).json().messages.map(message => message.id), ['large-1']);
  const deleted = await call(`extensions/${extensionId}/delete`, { expectedName: state.extension.name,
    draftVersion: state.draftVersion, generation: state.selection.generation });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await call(earlier)).statusCode, 404);
  assert.equal(fake.requests.length, 0);
});

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
test('a missing companion at app startup leaves native tasks available and rejects authoring before admission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'daymark-guide-'));
  t.after(() => removeFixture(directory));
  substituteGuide(t, join(directory, 'missing.md'));
  let providers = 0;
  const { db, call, login } = await api(t, { config: configFor(), providerFactory: () => { providers++; } });
  await login();
  const task = db.prepare("SELECT id FROM tasks WHERE owner_id='maya' LIMIT 1").get();
  assert.equal((await call('tasks/' + task.id)).statusCode, 200);
  const listing = (await call('authoring')).json();
  assert.equal(listing.availability.available, false);
  assert.equal(listing.availability.code, 'AUTHORING_GUIDE_UNAVAILABLE');
  const request = { conversationId: null, operationId: 'missing-guide', text: 'Prepare a change.',
    expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } };
  const rejected = await call('authoring/turn', request);
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().code, listing.availability.code);
  assert.equal(providers, 0);
  for (const table of ['authoring_conversations', 'authoring_operations', 'authoring_dispatches']) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assert.equal(reserved(db), 0);
});

for (const provider of ['openai', 'anthropic']) test(`${provider} API repairs real pinned-JAR diagnostics, saves original cases and offers exact simulator evidence without approval`,
  { skip: !qualifiedJava && !process.env.CI }, async t => {
    assert.ok(qualifiedJava, 'Qualified Java 21 is required in CI.');
    const cases = taskCases().map(item => '\n ' + item.bytes.toString() + '\n');
    let compiledId, scenarioId, exactEvidenceId, latestEvidenceId, callApi, providers = 0;
    const fake = wire(provider, async (body, index) => {
      const prior = lastTool(provider, body);
      if (index === 6) return { text: 'The saved change is still here.' };
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
    const realCompiler = createCompiler({ javaExecutable: java });
    const { db, call, login } = await api(t, { config: configFor(provider), providerFactory(config) {
      providers++;
      return createAuthoringProvider(config, { fetchImpl: fake.fetchImpl });
    } }, { compiler: realCompiler });
    callApi = call;
    await login(); const selection = (await call(extensionPath(db))).json().selection;
    const submitted = input(db, 'real-compile');
    const response = await call('authoring/turn', submitted);
    assert.equal(response.statusCode, 202);
    const current = await settled(call, response.json().conversation.id);
    assert.equal(current.status, 'REVIEW_AVAILABLE', JSON.stringify(current)); assertDto(current);
    assert.equal(current.review.eligible, true);
    const state = (await call(extensionPath(db))).json(), review = current.review;
    assert.equal(review.revisionId, state.draft.id); assert.equal(review.draftVersion, state.draftVersion);
    assert.equal(review.suiteDigest, state.suiteDigest); assert.equal(review.evidenceId, exactEvidenceId);
    const receipt = { revisionId: review.revisionId, draftVersion: review.draftVersion,
      suiteDigest: review.suiteDigest, evidenceId: exactEvidenceId };
    assert.deepEqual(current.messages.at(-1).receipt, receipt);
    const savedView = JSON.parse(db.prepare('SELECT view FROM authoring_conversations WHERE id=?').get(current.id).view);
    assert.deepEqual(savedView.messages, [], 'The current header does not accumulate transcript history.');
    const savedMessage = JSON.parse(db.prepare('SELECT payload FROM authoring_messages WHERE conversation_id=? AND message_id=?').get(current.id, current.messages.at(-1).id).payload);
    assert.deepEqual(savedMessage.receipt, receipt, 'The exact turn receipt is durable, not inferred from latest evidence.');
    assert.equal(current.messages[0].receipt, undefined);
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
    assert.equal(dispatches(db, current.id).length, 12); assert.ok(dispatches(db, current.id).every(item => item.outcome === 'SUCCESS'));
    const index = 'authoring?extensionId=' + current.extensionId;
    assert.equal((await call(index)).json().availability.available, true);
    const directory = mkdtempSync(join(tmpdir(), 'daymark-guide-'));
    t.after(() => removeFixture(directory));
    const altered = join(directory, 'tampered.md'), original = fs.readFileSync(guideFile);
    original[0] ^= 1;
    fs.writeFileSync(altered, original);
    const open = substituteGuide(t, altered);
    const next = { ...submitted, operationId: 'resume-with-guide', expectedVersion: current.version, expectedDraftVersion: state.draftVersion };
    const snapshot = () => ({
      conversation: db.prepare('SELECT * FROM authoring_conversations WHERE id=?').get(current.id),
      operations: db.prepare('SELECT * FROM authoring_operations ORDER BY rowid').all(),
      dispatches: dispatches(db, current.id), reserved: reserved(db),
    });
    const savedBefore = snapshot();
    const rejected = await call('authoring/turn', next);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json().code, 'AUTHORING_GUIDE_UNAVAILABLE');
    const unavailable = (await call(index)).json();
    assert.equal(unavailable.availability.available, false);
    assert.deepEqual(unavailable.current.review, review);
    assert.deepEqual((await call(extensionPath(db, 'evidence/' + review.evidenceId))).json(), proof);
    const replay = await call('authoring/turn', submitted);
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json().operation, response.json().operation);
    assert.deepEqual(snapshot(), savedBefore);
    assert.equal(providers, 1);
    assert.equal(fake.requests.length, 6);
    open.mock.restore();
    assert.equal((await call(index)).json().availability.available, true);
    const restored = await call('authoring/turn', { ...next, conversationId: null, target: { kind: 'create' },
      expectedVersion: 0, expectedDraftVersion: 0 });
    assert.equal(restored.statusCode, 202);
    assert.equal((await settled(call, restored.json().conversation.id)).status, 'IDLE');
    assert.equal(providers, 2);
    assert.equal(fake.requests.length, 7);
    const changed = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source, draftVersion: 2 });
    assert.equal(changed.statusCode, 200);
    const historical = (await call('authoring/conversations/' + current.id)).json();
    assert.equal(historical.review.eligible, false);
    assert.deepEqual(historical.messages.at(-1).receipt, receipt, 'Later drafts cannot retarget an earlier turn’s examples.');
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
  assert.equal(dispatches(db, current.id).length, stage === 'beforeCommit' ? 0 : 1);
  if (stage === 'afterCommit') assert.equal(dispatches(db, current.id)[0].outcome, 'UNKNOWN');
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
  const currentB = await lifecycle.compile('maya', { extensionId: itemId(lifecycle, 'maya'), hookId: TASK_HOOK, source, draftVersion: 0 }, () => {});
  const state = rowState(db);
  state.status = 'RUNNING'; state.inFlight = { ordinal: 3, kind: 'provider' };
  state.dispatchOrdinal = 3; state.checkpoint = { phase: 'DISPATCH', ...state.inFlight };
  state.counts.calls++; state.usage.reservedMicros += configFor('anthropic').reserveMicros;
  state.runLedger.ordinal = 3; state.runLedger.reserved += configFor('anthropic').reserveMicros;
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,NULL)').run(saved.id, 'maya', saved.runId, 3, 'provider', null, configFor('anthropic').reserveMicros);
  db.prepare('UPDATE authoring_budget SET reserved_micros=reserved_micros+?').run(configFor('anthropic').reserveMicros);
  db.prepare("UPDATE authoring_conversations SET status='RUNNING',state=? WHERE id=?").run(JSON.stringify(state), saved.id);
  const held = reserved(db); db.close();
  db = openData(path); lifecycle = createLifecycle(db, { compiler });
  service = createAuthoringService({ db, lifecycle, config: configFor('anthropic'), fetchImpl: fake.fetchImpl });
  const recovered = service.read('maya', saved.id);
  assert.equal(recovered.status, 'INTERRUPTED'); assert.equal(recovered.code, 'RUN_INTERRUPTED');
  assert.equal(recovered.draft.revisionId, saved.draft.revisionId); assert.equal(recovered.draft.draftVersion, saved.draft.draftVersion); assert.equal(recovered.review, null);
  assert.equal(lifecycle.state('maya', itemId(lifecycle, 'maya')).revisionId, currentB.revisionId);
  assert.equal(dispatches(db, saved.id).at(-1).outcome, 'UNKNOWN');
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
  const value = JSON.parse(taskCases()[0].bytes.toString());
  value.expect.outcome.result.status = 'NO_OP';
  value.expect.consumption.result.status = 'NO_OP';
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
  assert.equal(proof.passed, false); assert.equal(proof.reports[0].report.status, 'FAIL');
  assert.deepEqual(lifecycle.source('maya', result.review.revisionId, itemId(lifecycle, 'maya')).cases, [original]);
  assert.equal(fake.requests.length, 4); assert.equal(rowState(db).counts.compiles, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.deepEqual(lifecycle.state('maya', itemId(lifecycle, 'maya')).selection, selection);
});

test('oversized active native context settles BLOCKED with retained credit and allows explicit continuation', async t => {
  const config = configFor(); let calls = 0, resultSaved = false, resultRow;
  const { db, service } = direct(t, { providerFactory: () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      return { continuation: { provider: 'openai', items: calls === 1 ? ['x'.repeat(260825)] : [] }, calls: [],
        text: calls === 1 ? 'y'.repeat(1000) : 'Ready.', usage: { inputTokens: 1, outputTokens: 1 } };
    } }), checkpointFault: point => {
      if (point.phase === 'RESULT' && point.stage === 'afterCommit' && calls === 1) {
        resultSaved = true; resultRow = db.prepare('SELECT * FROM authoring_conversations').get();
      }
    } });
  const started = await service.turn('maya', input(db, 'large'), lease('session'));
  const blocked = await service.wait('maya', started.conversation.id);
  assert.equal(resultSaved, true, 'The provider result fits; only terminal state exceeds the byte limit.');
  assert.ok(Buffer.byteLength(resultRow.state) + Buffer.byteLength(resultRow.operations) + Buffer.byteLength(resultRow.view) <= 262144);
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.code, 'CONTEXT_LIMIT');
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

test('an individually oversized terminal reply fails BYTE_LIMIT without releasing credit or stranding the conversation', async t => {
  const config = configFor(); let calls = 0;
  const { db, service } = direct(t, { providerFactory: () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      return { calls: [], text: calls === 1 ? 'x'.repeat(131073) : 'Ready.', usage: { inputTokens: 1, outputTokens: 1 } };
    } }) });
  const started = await service.turn('maya', input(db, 'oversized-message'), lease('session'));
  const blocked = await service.wait('maya', started.conversation.id);
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.code, 'BYTE_LIMIT'); assertDto(blocked);
  assert.equal(reserved(db), config.reserveMicros);
  assert.ok(dispatches(db, blocked.id).every(item => item.outcome === 'SUCCESS'));
  assert.equal(blocked.messages.some(message => message.text.length > 131072), false);
  const resumed = await service.turn('maya', input(db, 'after-oversized-message', { conversationId: blocked.id, expectedVersion: 1 }), lease('session'));
  assert.equal((await service.wait('maya', resumed.conversation.id)).status, 'IDLE');
  assert.equal(calls, 2); assert.equal(reserved(db), config.reserveMicros * 2);
});

for (const mutation of ['source', 'cases']) test(`${mutation} commit survives lost tool-result checkpoint; old chat retains A and a new revision conversation uses B`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-result-')), path = join(directory, 'app.sqlite');
  let db = openData(path), lifecycle = createLifecycle(db, { compiler }), service;
  t.after(async () => { await service?.close(); db.close(); removeFixture(directory); });
  const selectedA = lifecycle.state('maya', itemId(lifecycle, 'maya')).selection;
  const initial = await lifecycle.compile('maya', { extensionId: itemId(lifecycle, 'maya'), hookId: TASK_HOOK, source, draftVersion: 0 }, () => {});
  const initialSource = lifecycle.source('maya', initial.revisionId, initial.extension.id);
  const fake = wire('openai', (body, index) => {
    if (index === 0) return mutation === 'source'
      ? { name: 'compile_draft', arguments: { sourceJson: source, expectedDraftVersion: 1 } }
      : { name: 'propose_scenarios', arguments: { revisionId: initial.revisionId, cases: [taskCases()[0].bytes.toString()], expectedDraftVersion: 1 } };
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
  assert.equal(dispatches(db, stopped.id).at(-1).outcome, 'UNKNOWN');
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
  const cases = taskCases().map(item => '\n ' + item.bytes.toString() + '\n');
  const malformed = cases.map(text => JSON.parse(text)).find(row => row.id === 'missing-task'); delete malformed.expect.outcome.error.path;
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
  const compiled = (await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source, draftVersion: 0 })).json();
  const valid = taskCases()[0].bytes.toString();
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

for (const secondLength of [8192, 6000]) test(`durable transcript beyond header capacity accepts ${secondLength}-byte next input and remains fully readable through pages`, async t => {
  const config = configFor(); let calls = 0;
  const { db, call, login } = await api(t, { config, providerFactory: () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      return { calls: [], text: calls === 1 ? 'x'.repeat(122500) : 'Second request completed.', usage: { inputTokens: 1, outputTokens: 1 } };
    } }) });
  await login();
  const first = await call('authoring/turn', input(db, 'near-cap'));
  assert.equal(first.statusCode, 202);
  const saved = await settled(call, first.json().conversation.id);
  assert.equal(saved.status, 'IDLE'); assert.equal(saved.messages.at(-1).text.length, 122500);
  const retained = Array.from({ length: 2 }, (_, index) => ({ id: `earlier-message-${index}`, role: 'assistant', kind: 'text', text: `${index}`.repeat(122500) }));
  for (const [index, message] of retained.entries()) db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)')
    .run(saved.id, 'maya', index + 3, message.id, JSON.stringify(message));
  assert.ok(db.prepare('SELECT sum(length(CAST(payload AS BLOB))) bytes FROM authoring_messages WHERE conversation_id=?').get(saved.id).bytes > 262144);
  const second = await call('authoring/turn', input(db, 'follow-up', { conversationId: saved.id, expectedVersion: 1, text: 'y'.repeat(secondLength) }));
  assert.equal(second.statusCode, 202);
  const finished = await settled(call, saved.id);
  assert.equal(finished.status, 'IDLE'); assert.equal(finished.messages.at(-1).text, 'Second request completed.');
  assert.equal(calls, 2); assert.equal(reserved(db), config.reserveMicros * 2);
  assert.ok(Buffer.byteLength(JSON.stringify(finished)) <= 131072); assertDto(finished);
  const messages = [...finished.messages]; let before = finished.messagesBefore;
  while (before) {
    const page = await call(`authoring/conversations/${saved.id}/messages?before=${encodeURIComponent(before)}`);
    assert.equal(page.statusCode, 200); assert.ok(Buffer.byteLength(page.body) <= 262144);
    const value = page.json(); messages.unshift(...value.messages); before = value.next;
  }
  assert.equal(messages.length, 6); assert.equal(new Set(messages.map(message => message.id)).size, 6);
  assert.equal(messages[1].text, 'x'.repeat(122500)); assert.deepEqual(messages.slice(2, 4), retained);
  assert.equal(messages[4].text, 'y'.repeat(secondLength));
  const row = db.prepare('SELECT view,operations FROM authoring_conversations WHERE id=?').get(saved.id);
  assert.deepEqual(JSON.parse(row.view).messages, []); assert.equal(JSON.parse(row.operations).length, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM authoring_operations WHERE conversation_id=?').get(saved.id).count, 2);
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
