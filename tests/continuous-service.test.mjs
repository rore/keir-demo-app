import test from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createApp } from '../src/app.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';

const configuration = revision => readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
  KEIR_AI_MAX_USD: '100', OPENAI_API_KEY: 'synthetic-test-key' }, revision);
const lease = { sessionId: 'offline-session', current: () => true };
const start = (operationId, text = `Request ${operationId}: λ😀\n`) => ({ conversationId: null, operationId, text,
  expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } });
const resume = (conversation, operationId) => ({ conversationId: conversation.id, operationId,
  text: `Request ${operationId}: λ😀\n`, expectedVersion: conversation.version,
  expectedDraftVersion: conversation.draft.draftVersion, target: { kind: 'resume', extensionId: conversation.extensionId } });
const held = db => db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
const changes = db => db.prepare('SELECT total_changes() n').get().n;
const messages = (db, id) => db.prepare('SELECT payload FROM authoring_messages WHERE conversation_id=? ORDER BY sequence').all(id).map(row => JSON.parse(row.payload));
const saved = (db, id) => JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(id).state);
const checkPage = page => {
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 262144);
  if (page.messages) assert.ok(page.messages.length <= 20);
  if (page.conversations) assert.ok(page.conversations.length <= 20);
};
function setup(t) {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler: {} }), config = configuration('settings-one');
  let providerCalls = 0, service;
  const providerFactory = value => {
    let first = true, text;
    return { reserveMicros: value.reserveMicros, maxMicros: value.maxMicros,
      async complete(request) {
        const sequence = ++providerCalls;
        if (first) {
          first = false; text = request.input;
          return { calls: [{ id: `discover-${sequence}`, name: 'discover_catalog', arguments: {} }], text: '',
            continuation: { provider: 'synthetic', items: [] }, usage: { inputTokens: 2, outputTokens: 1 } };
        }
        return { calls: [], text: `Reply to ${text}`, continuation: { provider: 'synthetic', items: [] },
          usage: { inputTokens: 2, outputTokens: 1 } };
      } };
  };
  const reopen = () => (service = createAuthoringService({ db, lifecycle, config, providerFactory }));
  reopen();
  t.after(async () => { await service.close(); db.close(); });
  return { db, lifecycle, config, providerFactory, reopen, get service() { return service; }, get providerCalls() { return providerCalls; } };
}
async function turn(service, input) {
  const accepted = await service.turn('maya', input, lease);
  const conversation = await service.wait('maya', accepted.conversation.id);
  assert.equal(conversation.status, 'IDLE', JSON.stringify(conversation));
  return { ...accepted, conversation };
}
async function api(t, fixture) {
  const origin = 'http://127.0.0.1:32127';
  const app = await createApp({ db: fixture.db, origin, compiler: {}, authoring: { config: fixture.config, providerFactory: fixture.providerFactory } });
  t.after(() => app.close());
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32127', origin, 'content-type': 'application/json', ...auth, ...headers }, ...(payload === undefined ? {} : { payload }) });
  return { call, async login(userId = 'maya') {
    const bootstrap = (await call('session')).json();
    const result = await call('session', { userId }, { 'x-session-context': bootstrap.contextToken });
    assert.equal(result.statusCode, 200);
    auth = { cookie: result.headers['set-cookie'].split(';')[0], 'x-session-context': result.json().contextToken };
  } };
}

test('durable operations, dispatches and exact transcript survive many turns, restart and early receipt recovery', async t => {
  const f = setup(t), firstInput = start('first-operation', 'Original request: λ😀\n\0');
  const first = await turn(f.service, firstInput), id = first.conversation.id;
  let conversation = first.conversation;
  for (let index = 1; index < 25; index++) conversation = (await turn(f.service, resume(conversation, `later-${index}`))).conversation;
  const rows = messages(f.db, id);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows[0], { id: firstInput.operationId, role: 'user', text: firstInput.text, kind: 'text' });
  assert.deepEqual(rows[1], { id: first.operation.runId + '-assistant', role: 'assistant', text: 'Reply to ' + firstInput.text, kind: 'text' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM authoring_operations WHERE conversation_id=?').get(id).n, 25);
  assert.equal(f.db.prepare('SELECT count(*) n FROM authoring_dispatches WHERE conversation_id=?').get(id).n, 75);
  assert.equal(f.db.prepare("SELECT count(*) n FROM authoring_dispatches WHERE conversation_id=? AND outcome='SUCCESS'").get(id).n, 75);
  assert.deepEqual(saved(f.db, id).counts, { calls: 50, tools: 25, compiles: 0, simulations: 0, clarifications: 0, inputs: 25 });
  assert.equal(saved(f.db, id).usage.reservedMicros, 50 * f.config.reserveMicros);
  assert.equal(held(f.db), 50 * f.config.reserveMicros);
  const before = changes(f.db), calls = f.providerCalls;
  const recent = f.service.read('maya', id);
  assert.equal(f.lifecycle.collection('maya').items.find(row => row.extension.id === first.conversation.extensionId).requestExcerpt, firstInput.text.trim());
  assert.equal(recent.messages.length, 20);
  let transcript = recent.messages, cursor = recent.messagesBefore;
  while (cursor !== null) {
    const page = f.service.messages('maya', id, cursor); checkPage(page);
    transcript = [...page.messages, ...transcript]; cursor = page.next;
  }
  assert.deepEqual(transcript, rows);
  assert.deepEqual((await f.service.turn('maya', firstInput, lease)).operation, first.operation);
  assert.deepEqual(f.service.recover('maya', firstInput).operation, first.operation);
  await assert.rejects(f.service.turn('maya', { ...firstInput, text: 'Conflicting request' }, lease), { status: 409 });
  assert.throws(() => f.service.recover('maya', { ...firstInput, text: 'Conflicting request' }), { status: 409 });
  assert.throws(() => f.service.recover('leo', firstInput), { status: 404 });
  assert.equal(changes(f.db), before);
  assert.equal(f.providerCalls, calls);
  await f.service.close(); f.reopen();
  assert.deepEqual(f.service.recover('maya', firstInput).operation, first.operation);
  assert.equal(f.providerCalls, calls);
  await f.service.close();
  const transportBefore = changes(f.db);
  const http = await api(t, f); await http.login();
  assert.equal((await http.call('authoring/recover', firstInput)).statusCode, 200);
  assert.deepEqual((await http.call('authoring/recover', firstInput)).json().operation, first.operation);
  assert.equal((await http.call('authoring/turn', firstInput)).statusCode, 202);
  assert.equal((await http.call('authoring/turn', { ...firstInput, text: 'Conflict' })).statusCode, 409);
  assert.equal((await http.call('authoring/recover', { ...firstInput, text: 'Conflict' })).statusCode, 409);
  await http.login('leo');
  assert.equal((await http.call('authoring/recover', firstInput)).statusCode, 404);
  assert.equal((await http.call(`authoring/conversations/${id}/messages`)).statusCode, 404);
  assert.equal(changes(f.db), transportBefore);
  assert.equal(f.providerCalls, calls);
  assert.equal(held(f.db), 50 * f.config.reserveMicros);
});

test('conversation pages remain stable after updates, fence scope, and recover creations beyond the first page', async t => {
  const f = setup(t), first = await turn(f.service, start('oldest-create'));
  const item = first.conversation.extensionId;
  for (let index = 0; index < 23; index++) {
    const input = { ...start(`discussion-${index}`), target: { kind: 'revise', extensionId: item, baseRevisionId: null,
      selectionGeneration: f.lifecycle.state('maya', item).selection.generation } };
    await turn(f.service, input);
  }
  const firstPage = f.service.list('maya', item); checkPage(firstPage);
  assert.equal(firstPage.conversations.length, 20);
  assert.equal(firstPage.conversations.some(row => row.id === first.conversation.id), false);
  const ordered = f.db.prepare('SELECT id FROM authoring_conversations WHERE owner_id=? ORDER BY created_at DESC,id DESC').all('maya').map(row => row.id);
  f.db.prepare('UPDATE authoring_conversations SET updated_at=? WHERE id=?').run(Date.now() + 999999, ordered.at(-1));
  const before = changes(f.db), calls = f.providerCalls;
  const secondPage = f.service.list('maya', item, firstPage.next); checkPage(secondPage);
  assert.deepEqual([...firstPage.conversations, ...secondPage.conversations].map(row => row.id), ordered);
  assert.equal(secondPage.next, null);
  assert.equal(firstPage.current.id, ordered[0]);
  assert.equal(secondPage.current.id, firstPage.current.id);
  assert.throws(() => f.service.list('leo', undefined, firstPage.next), { status: 400 });
  assert.throws(() => f.service.list('maya', undefined, firstPage.next), { status: 400 });
  for (const cursor of ['bad!', '', Buffer.from(JSON.stringify({ scope: JSON.stringify(['conversations', 'maya', item]), id: 'missing', createdAt: 0 })).toString('base64url')])
    assert.throws(() => f.service.list('maya', item, cursor), { status: 400 });
  assert.throws(() => f.service.messages('maya', first.conversation.id, firstPage.next), { status: 400 });
  assert.equal(changes(f.db), before); assert.equal(f.providerCalls, calls);
  for (let index = 0; index < 22; index++) await turn(f.service, start(`additional-create-${index}`));
  assert.equal(f.service.list('maya').conversations.some(row => row.id === first.conversation.id), false);
  const collection = f.lifecycle.collection('maya');
  assert.equal(collection.items.some(row => row.extension.id === item), false);
  assert.equal(f.lifecycle.findCreation('maya', 'oldest-create').extension.id, item);
  assert.equal(f.service.recover('maya', start('oldest-create')).conversation.extensionId, item);
  await f.service.close();
  const http = await api(t, f); await http.login();
  const readBefore = changes(f.db), heldBefore = held(f.db), callsBefore = f.providerCalls;
  assert.equal((await http.call('extensions/creation/oldest-create')).json().extension.id, item);
  assert.equal((await http.call('authoring/recover', start('oldest-create'))).json().operation.runId, first.operation.runId);
  assert.equal((await http.call(`authoring?extensionId=${item}&before=bad!`)).statusCode, 400);
  assert.equal((await http.call(`authoring?before=${firstPage.next}`)).statusCode, 400);
  await http.login('leo');
  assert.equal((await http.call('extensions/creation/oldest-create')).statusCode, 404);
  assert.equal(changes(f.db), readBefore); assert.equal(held(f.db), heldBefore); assert.equal(f.providerCalls, callsBefore);
});

test('old resource policy and age resume the same conversation while actual settings revision still fences edits', async t => {
  const f = setup(t), original = await turn(f.service, start('policy-create')), id = original.conversation.id;
  const old = saved(f.db, id);
  old.transport.policy = 'bounded-ai-authoring/1'; old.createdAt -= 3 * 86400000; old.activeMs = 180000;
  f.db.prepare('UPDATE authoring_conversations SET state=? WHERE id=?').run(JSON.stringify(old), id);
  await f.service.close(); f.reopen();
  const continued = await turn(f.service, resume(f.service.read('maya', id), 'after-policy-upgrade'));
  assert.equal(continued.conversation.id, id);
  assert.equal(saved(f.db, id).transport.policy, 'continuous-ai-authoring/3');
  assert.ok(saved(f.db, id).activeMs >= 180000);
  assert.equal(saved(f.db, id).counts.inputs, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 1);
  f.service.configure(configuration('settings-two'), () => {});
  const before = changes(f.db), calls = f.providerCalls, reserved = held(f.db);
  await assert.rejects(f.service.turn('maya', resume(continued.conversation, 'changed-real-settings'), lease), { status: 409, code: 'CONFIG_CHANGED' });
  assert.deepEqual(f.service.recover('maya', start('policy-create')).operation, original.operation);
  assert.deepEqual((await f.service.turn('maya', start('policy-create'), lease)).operation, original.operation);
  assert.equal(changes(f.db), before); assert.equal(f.providerCalls, calls); assert.equal(held(f.db), reserved);
});

test('largest legal legacy message stays reachable with exact receipt even when the recent DTO has no room', async t => {
  const f = setup(t), created = await turn(f.service, start('largest-message')), id = created.conversation.id;
  const legacy = { id: 'largest-legacy-message', role: 'assistant', kind: 'review', text: '',
    receipt: { revisionId: 'historical-revision', draftVersion: 7, suiteDigest: 'sha256:' + '1'.repeat(64), evidenceId: 'historical-proof' } };
  legacy.text = 'x'.repeat(131072 - Buffer.byteLength(JSON.stringify(legacy)));
  assert.equal(Buffer.byteLength(JSON.stringify(legacy)), 131072);
  f.db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run(id, 'maya', 3, legacy.id, JSON.stringify(legacy));
  const before = changes(f.db), calls = f.providerCalls, reserved = held(f.db);
  const dto = f.service.read('maya', id);
  assert.deepEqual(dto.messages, []); assert.ok(dto.messagesBefore);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= 131072);
  const page = f.service.messages('maya', id, dto.messagesBefore); checkPage(page);
  assert.deepEqual(page.messages, messages(f.db, id));
  assert.deepEqual(page.messages.at(-1), legacy);
  assert.equal(page.next, null);
  assert.equal(changes(f.db), before); assert.equal(f.providerCalls, calls); assert.equal(held(f.db), reserved);
  const other = await turn(f.service, start('other-message-owner-scope'));
  assert.throws(() => f.service.messages('maya', other.conversation.id, dto.messagesBefore), { status: 400 });
  assert.throws(() => f.service.messages('leo', id, dto.messagesBefore), { status: 404 });
  assert.throws(() => f.service.messages('maya', id, 'bad!'), { status: 400 });
  for (const change of [{ sequence: '3' }, { sequence: 99999 }, { inclusive: 'true' }, { inclusive: undefined }]) {
    const invalid = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(dto.messagesBefore, 'base64url').toString()), ...change })).toString('base64url');
    assert.throws(() => f.service.messages('maya', id, invalid), { status: 400 });
  }
  await f.service.close();
  const readsBefore = changes(f.db), readsHeld = held(f.db), readsCalls = f.providerCalls;
  const http = await api(t, f); await http.login();
  const fetched = await http.call(`authoring/conversations/${id}/messages?before=${dto.messagesBefore}`);
  assert.equal(fetched.statusCode, 200); assert.deepEqual(fetched.json().messages, page.messages);
  assert.equal(changes(f.db), readsBefore); assert.equal(held(f.db), readsHeld); assert.equal(f.providerCalls, readsCalls);
  assert.ok(changes(f.db) > before); assert.equal(f.providerCalls, calls + 2); assert.equal(held(f.db), reserved + 2 * f.config.reserveMicros);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const kind of ['provider', 'tool']) test(`context capacity preserves definitive ${kind} SUCCESS and usage before explicit same-chat continuation`, async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler: {} }), config = configuration('capacity-settings');
  let calls = 0;
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: () => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete() {
      calls++;
      return { continuation: { provider: 'openai', items: calls === 1 ? ['x'.repeat(kind === 'provider' ? 261300 : 255000)] : [] },
        calls: kind === 'tool' && calls === 1 ? [{ id: 'capacity-discovery', name: 'discover_catalog', arguments: {} }] : [],
        text: 'Done.', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }) });
  t.after(async () => { await service.close(); db.close(); });
  const accepted = await service.turn('maya', start(`capacity-${kind}`), lease);
  const stopped = await service.wait('maya', accepted.conversation.id);
  assert.equal(stopped.status, 'BLOCKED'); assert.equal(stopped.code, 'CONTEXT_LIMIT');
  assert.equal(calls, 1);
  const outcomes = () => db.prepare('SELECT kind,outcome FROM authoring_dispatches ORDER BY rowid').all().map(row => ({ ...row }));
  assert.deepEqual(outcomes(), [{ kind: 'provider', outcome: 'SUCCESS' }, ...(kind === 'tool' ? [{ kind: 'tool', outcome: 'SUCCESS' }] : [])]);
  assert.deepEqual(saved(db, stopped.id).usage, { inputTokens: 1, outputTokens: 1, reservedMicros: config.reserveMicros });
  assert.equal(saved(db, stopped.id).counts.calls, 1);
  assert.equal(saved(db, stopped.id).counts.tools, kind === 'tool' ? 1 : 0);
  assert.equal(saved(db, stopped.id).continuation, undefined);
  assert.equal(saved(db, stopped.id).pending, undefined);
  assert.equal(held(db), config.reserveMicros);
  const continued = await turn(service, resume(stopped, `continue-capacity-${kind}`));
  assert.equal(continued.conversation.id, stopped.id);
  assert.equal(calls, 2); assert.equal(held(db), 2 * config.reserveMicros);
  assert.deepEqual(outcomes().at(-1), { kind: 'provider', outcome: 'SUCCESS' });
  assert.equal(outcomes().length, kind === 'tool' ? 3 : 2);
  assert.deepEqual(saved(db, stopped.id).usage, { inputTokens: 2, outputTokens: 2, reservedMicros: 2 * config.reserveMicros });
});

test('fresh operation IDs cannot collide with assistant message IDs or drop accepted user text', async t => {
  const f = setup(t), input = start('collision-original'), accepted = await turn(f.service, input);
  const id = accepted.conversation.id, transcript = messages(f.db, id);
  const conflicting = resume(accepted.conversation, transcript.at(-1).id);
  const before = changes(f.db), reserved = held(f.db), calls = f.providerCalls;
  await assert.rejects(f.service.turn('maya', conflicting, lease), { status: 409, code: 'STALE_CONVERSATION' });
  assert.deepEqual(messages(f.db, id), transcript);
  assert.equal(f.db.prepare('SELECT count(*) n FROM authoring_operations WHERE conversation_id=?').get(id).n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM authoring_dispatches WHERE conversation_id=?').get(id).n, 3);
  assert.deepEqual((await f.service.turn('maya', input, lease)).operation, accepted.operation, 'exact original operation deduplication still precedes collision rejection');
  assert.equal(changes(f.db), before); assert.equal(held(f.db), reserved); assert.equal(f.providerCalls, calls);
});
