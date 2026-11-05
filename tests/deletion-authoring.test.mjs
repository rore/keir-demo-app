import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createLifecycle as lifecycleFactory } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { TASK_HOOK } from '../src/extension-catalog.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const source = taskCustomizationFixture().source;
const compiler = { compile: async () => assert.fail('This deletion fixture must not compile outside the controlled cancellation case.') };
const lifecycleDatabases = new WeakMap();
function createLifecycle(db, options) {
  const lifecycle = lifecycleFactory(db, options); lifecycleDatabases.set(lifecycle, db); return lifecycle;
}
const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
  KEIR_AI_MAX_USD: '100', OPENAI_API_KEY: 'synthetic-secret-key' });
const lease = { sessionId: 'synthetic-session', current: () => true };
const authorize = () => {};

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const done = { calls: [], text: 'Saved discussion.', usage: { inputTokens: 1, outputTokens: 1 } };
function provider(complete = async () => done) {
  let calls = 0;
  return { get calls() { return calls; }, providerFactory: () => ({ reserveMicros: config.reserveMicros,
    maxMicros: config.maxMicros, complete: async (...args) => { calls++; return complete(...args); } }) };
}
function firstItem(lifecycle, owner = 'maya') {
  const db = lifecycleDatabases.get(lifecycle), operationId = 'deletion-fixture-' + owner;
  const row = db.prepare('SELECT id FROM extensions WHERE owner_id=? AND creation_operation_id=?').get(owner, operationId);
  return row?.id ?? admitTaskDraft(db, lifecycle, { owner, operationId }).extensionId;
}
function request(lifecycle, extensionId, operationId, owner = 'maya') {
  const state = lifecycle.state(owner, extensionId);
  const initial = lifecycleDatabases.get(lifecycle).prepare("SELECT c.id FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id WHERE l.owner_id=? AND l.extension_id=? AND c.version=0").get(owner, extensionId);
  return { conversationId: initial?.id ?? null, operationId, text: 'Help with this customization.', expectedVersion: 0,
    expectedDraftVersion: state.draftVersion, target: initial ? { kind: 'resume', extensionId } : { kind: 'revise', extensionId,
      baseRevisionId: state.revisionId ?? state.selection.revision?.id ?? null, selectionGeneration: state.selection.generation } };
}
const createRequest = operationId => ({ conversationId: null, operationId, text: 'Help create a customization.',
  expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } });
function confirmation(lifecycle, extensionId, owner = 'maya') {
  const state = lifecycle.state(owner, extensionId);
  return { extensionId, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation };
}
function removeFixture(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
function direct(t, options = {}) {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler, ...options.lifecycle });
  const fake = provider(options.complete);
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: fake.providerFactory });
  t.after(async () => { options.release?.(); await service.close(); db.close(); });
  return { db, lifecycle, service, fake };
}
async function api(t, options = {}) {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32123', fake = provider(options.complete);
  const app = await createApp({ db, origin, compiler: options.compiler ?? compiler,
    authoring: { config, providerFactory: fake.providerFactory } });
  t.after(async () => { options.release?.(); await app.close(); db.close(); });
  let auth = {};
  const call = (url, payload, headers = {}) => app.inject({ url: '/api/' + url, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  const bootstrap = (await call('session')).json();
  const loggedIn = await call('session', { userId: 'maya' }, { 'x-session-context': bootstrap.contextToken });
  assert.equal(loggedIn.statusCode, 200);
  auth = { cookie: loggedIn.headers['set-cookie'].split(';')[0], 'x-session-context': loggedIn.json().contextToken };
  return { db, call, fake };
}
function bodyFor(state) {
  return { expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation };
}
async function settled(call, id) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = await call('authoring/conversations/' + id);
    assert.equal(response.statusCode, 200);
    if (!['RUNNING', 'CANCELLING'].includes(response.json().status)) return response.json();
    await tick();
  }
  assert.fail('Synthetic authoring did not settle.');
}

test('deletion wins admission without dispatch; only a new explicit creation can create another item', async t => {
  const { db, call, fake } = await api(t);
  const lifecycle = createLifecycle(db, { compiler }), extensionId = firstItem(lifecycle);
  const input = request(lifecycle, extensionId, 'after-delete');
  assert.equal((await call(`extensions/${extensionId}/delete`, bodyFor(lifecycle.state('maya', extensionId)))).statusCode, 200);
  assert.equal((await call('authoring/turn', input)).statusCode, 404);
  assert.equal(fake.calls, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM authoring_operations').get().n, 0);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 0);
  const created = await call('authoring/turn', createRequest('explicit-new-item'));
  assert.equal(created.statusCode, 202);
  assert.notEqual(created.json().conversation.extensionId, extensionId);
  await settled(call, created.json().conversation.id);
  assert.equal(fake.calls, 1);
});

test('admitted authoring blocks deletion through Stop and terminal-but-tracked compiler settlement', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred();
  const heldCompiler = { compile: async () => { entered.resolve(); await release.promise; return { diagnostics: [] }; } };
  const { db, call, fake } = await api(t, { compiler: heldCompiler, release: release.resolve,
    complete: async () => ({ calls: [{ id: 'compile', name: 'compile_draft', arguments: { hookId: TASK_HOOK, sourceJson: source, expectedDraftVersion: 0 } }],
      text: '', usage: { inputTokens: 1, outputTokens: 1 } }) });
  const lifecycle = createLifecycle(db, { compiler }), extensionId = firstItem(lifecycle);
  const before = lifecycle.state('maya', extensionId), body = bodyFor(before);
  const started = await call('authoring/turn', request(lifecycle, extensionId, 'held-compile'));
  assert.equal(started.statusCode, 202); await entered.promise;
  const { id, runId, version } = started.json().conversation;
  for (const status of ['RUNNING', 'CANCELLING', 'CANCELLED']) {
    if (status === 'CANCELLING') {
      assert.equal((await call(`authoring/conversations/${id}/cancel`, { runId, expectedVersion: version })).statusCode, 200);
    } else if (status === 'CANCELLED') {
      // A terminal persisted header must not bypass the independent live settlement handle.
      db.prepare('UPDATE authoring_conversations SET status=? WHERE id=?').run(status, id);
    }
    const rejected = await call(`extensions/${extensionId}/delete`, body);
    assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().code, 'CUSTOMIZATION_BUSY');
    assert.match(rejected.json().message, /Stop/);
    assert.equal(db.prepare('SELECT deleted_at FROM extensions WHERE id=?').get(extensionId).deleted_at, null);
  }
  db.prepare("UPDATE authoring_conversations SET status='CANCELLING' WHERE id=?").run(id);
  release.resolve();
  assert.equal((await settled(call, id)).status, 'CANCELLED');
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored').get().n, 0);
  assert.deepEqual(lifecycle.state('maya', extensionId).selection, before.selection);
  assert.equal((await call(`extensions/${extensionId}/delete`, body)).statusCode, 200);
  assert.equal((await call(`authoring/conversations/${id}`)).statusCode, 404);
  assert.equal(fake.calls, 1);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, config.reserveMicros);
});

test('live work for another item and another owner does not block deletion', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let active = 0;
  const { db, lifecycle, service } = direct(t, { release: release.resolve, complete: async () => {
    if (++active === 2) entered.resolve(); await release.promise; return done;
  } });
  const mayaItem = firstItem(lifecycle);
  const target = admitTaskDraft(db, lifecycle, { operationId: 'unrelated-item' }).state;
  const confirmationInput = confirmation(lifecycle, target.extension.id);
  const maya = await service.turn('maya', request(lifecycle, mayaItem, 'maya-busy'), lease);
  const leo = await service.turn('leo', request(lifecycle, firstItem(lifecycle, 'leo'), 'leo-busy', 'leo'), lease);
  await entered.promise;
  const receipt = lifecycle.delete('maya', confirmationInput, authorize, () => service.assertItemIdle('maya', target.extension.id));
  assert.equal(receipt.extensionId, target.extension.id);
  assert.equal(service.read('maya', maya.conversation.id).status, 'RUNNING');
  assert.equal(service.read('leo', leo.conversation.id).status, 'RUNNING');
  release.resolve();
  await Promise.all([service.wait('maya', maya.conversation.id), service.wait('leo', leo.conversation.id)]);
});

test('HTTP creation and resumed-turn recovery are terminal after deletion, with mismatch conflicts checked first', async t => {
  const { db, call, fake } = await api(t);
  const creation = createRequest('http-create');
  const started = await call('authoring/turn', creation);
  assert.equal(started.statusCode, 202);
  const id = started.json().conversation.id, extensionId = started.json().conversation.extensionId;
  const first = await settled(call, id);
  const resume = { ...creation, conversationId: id, operationId: 'http-resume', expectedVersion: first.version,
    target: { kind: 'resume', extensionId } };
  assert.equal((await call('authoring/turn', resume)).statusCode, 202);
  const finished = await settled(call, id);
  assert.equal(finished.version, 2); assert.equal(fake.calls, 2);
  const before = {
    held: db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros,
    operations: db.prepare('SELECT * FROM authoring_operations WHERE conversation_id=? ORDER BY admitted_version').all(id),
    messages: db.prepare('SELECT * FROM authoring_messages WHERE conversation_id=? ORDER BY sequence').all(id),
  };
  const state = (await call(`extensions/${extensionId}`)).json();
  assert.equal((await call(`extensions/${extensionId}/delete`, bodyFor(state))).statusCode, 200);
  for (const input of [creation, resume]) for (const endpoint of ['authoring/turn', 'authoring/recover']) {
    const exact = await call(endpoint, input);
    assert.equal(exact.statusCode, 410); assert.equal(exact.json().code, 'CUSTOMIZATION_DELETED');
    assert.equal(Object.hasOwn(exact.json(), 'conversation'), false);
    assert.equal((await call(endpoint, { ...input, text: 'Changed operation bytes.' })).statusCode, 409);
  }
  for (const path of [`extensions/${extensionId}`, `authoring?extensionId=${extensionId}`,
    `authoring/conversations/${id}`, `authoring/conversations/${id}/messages`]) {
    assert.equal((await call(path)).statusCode, 404);
  }
  assert.equal((await call(`extensions/creation/${creation.operationId}`)).statusCode, 410);
  assert.deepEqual((await call('authoring')).json().conversations, []);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, before.held);
  assert.deepEqual(db.prepare('SELECT * FROM authoring_operations WHERE conversation_id=? ORDER BY admitted_version').all(id), before.operations);
  assert.deepEqual(db.prepare('SELECT * FROM authoring_messages WHERE conversation_id=? ORDER BY sequence').all(id), before.messages);
  assert.equal(fake.calls, 2);
});

test('deleted authoring receipts and UNKNOWN spending survive reopen without paid replay or resurrection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-deleted-authoring-')), path = join(directory, 'app.sqlite');
  let db = openData(path), lifecycle = createLifecycle(db, { compiler }), service;
  const fake = provider(); let faulted = false;
  service = createAuthoringService({ db, lifecycle, config, providerFactory: fake.providerFactory, checkpointFault: point => {
    if (!faulted && point.phase === 'DISPATCH' && point.stage === 'afterCommit') { faulted = true; throw Error('synthetic uncertain dispatch'); }
  } });
  t.after(async () => { await service?.close(); db.close(); removeFixture(directory); });
  const input = createRequest('retained-operation');
  const started = await service.turn('maya', input, lease), id = started.conversation.id, extensionId = started.conversation.extensionId;
  assert.equal((await service.wait('maya', id)).code, 'CHECKPOINT_UNCERTAIN');
  assert.equal(fake.calls, 0);
  assert.equal(db.prepare('SELECT outcome FROM authoring_dispatches WHERE conversation_id=?').get(id).outcome, 'UNKNOWN');
  const tables = ['extension_revisions', 'extension_revision_links', 'extension_conversation_links', 'extension_authored',
    'extension_evidence', 'extension_approvals', 'extension_history', 'authoring_conversations', 'authoring_operations',
    'authoring_messages', 'authoring_dispatches', 'authoring_budget'];
  const retained = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = retained();
  const receipt = lifecycle.delete('maya', confirmation(lifecycle, extensionId), authorize, () => service.assertItemIdle('maya', extensionId));
  assert.deepEqual(retained(), before);
  const assertDeleted = async () => {
    assert.throws(() => service.read('maya', id), { status: 404 });
    assert.throws(() => service.messages('maya', id), { status: 404 });
    assert.throws(() => service.list('maya', extensionId), { status: 404 });
    assert.throws(() => service.cancel('maya', id, { runId: started.operation.runId, expectedVersion: 1 }, lease), { status: 404 });
    assert.equal(service.list('maya').conversations.some(item => item.id === id), false);
    assert.throws(() => lifecycle.findCreation('maya', input.operationId), { status: 410, code: 'CUSTOMIZATION_DELETED' });
    assert.throws(() => service.recover('maya', input), { status: 410, code: 'CUSTOMIZATION_DELETED' });
    await assert.rejects(service.turn('maya', input, lease), { status: 410, code: 'CUSTOMIZATION_DELETED' });
    const mismatched = { ...input, text: 'Different request using the same operation.' };
    assert.throws(() => service.recover('maya', mismatched), { status: 409 });
    await assert.rejects(service.turn('maya', mismatched, lease), { status: 409 });
    assert.deepEqual(retained(), before);
    assert.equal(fake.calls, 0);
  };
  await assertDeleted();
  await service.close(); db.close();
  db = openData(path); lifecycle = createLifecycle(db, { compiler });
  service = createAuthoringService({ db, lifecycle, config, providerFactory: fake.providerFactory });
  await assertDeleted();
  assert.deepEqual(lifecycle.delete('maya', { extensionId, expectedName: 'obsolete', draftVersion: 999, generation: 999 }, authorize), receipt);
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, config.reserveMicros);
});

test('deleted and unlinked discussions are filtered before paging while deleted anchors remain valid', async t => {
  const { db, lifecycle, service } = direct(t);
  const deletedItem = firstItem(lifecycle);
  const kept = admitTaskDraft(db, lifecycle, { operationId: 'kept-item' }).state;
  const conversations = [];
  for (let index = 0; index < 23; index++) {
    const extensionId = index % 2 ? kept.extension.id : deletedItem;
    const started = await service.turn('maya', request(lifecycle, extensionId, `discussion-${index}`), lease);
    await service.wait('maya', started.conversation.id);
    conversations.push(started.conversation.id);
  }
  const first = service.list('maya');
  assert.equal(first.conversations.length, 20); assert.ok(first.next);
  const anchor = JSON.parse(Buffer.from(first.next, 'base64url').toString('utf8'));
  const anchorLink = db.prepare('SELECT extension_id FROM extension_conversation_links WHERE conversation_id=?').get(anchor.id);
  const unlinkedId = conversations.find(id => id !== anchor.id && db.prepare('SELECT extension_id FROM extension_conversation_links WHERE conversation_id=?').get(id).extension_id !== anchorLink.extension_id);
  db.prepare('DELETE FROM extension_conversation_links WHERE conversation_id=?').run(unlinkedId);
  lifecycle.delete('maya', confirmation(lifecycle, anchorLink.extension_id), authorize, () => service.assertItemIdle('maya', anchorLink.extension_id));
  const after = service.list('maya');
  const expected = db.prepare(`SELECT c.id FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id AND l.owner_id=c.owner_id
    WHERE c.owner_id='maya' AND l.extension_id<>? ORDER BY c.created_at DESC,c.id DESC`).all(anchorLink.extension_id).map(row => row.id);
  assert.deepEqual(after.conversations.map(item => item.id), expected);
  assert.equal(after.next, null);
  assert.ok(after.conversations.every(item => item.id !== unlinkedId));
  assert.throws(() => service.read('maya', unlinkedId), { status: 404 });
  assert.throws(() => service.messages('maya', unlinkedId), { status: 404 });
  const continued = service.list('maya', undefined, first.next);
  assert.deepEqual(continued.conversations.map(item => item.id), expected.filter(id => {
    const row = db.prepare('SELECT created_at FROM authoring_conversations WHERE id=?').get(id);
    return row.created_at < anchor.createdAt || row.created_at === anchor.createdAt && id < anchor.id;
  }));
});
