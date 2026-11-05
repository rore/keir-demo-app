import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AppError, openData, transaction } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { digest } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const origin = 'http://127.0.0.1:32123';
const authorized = () => {};
const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
function onlyNameChanged(before, after, id, name) {
  const expected = structuredClone(before);
  expected.extensions.find(row => row.id === id).name = name;
  assert.deepEqual(after, expected, 'only the exact item name changes across every persisted table');
}
async function api(t) {
  const db = openData(':memory:'), app = await createApp({ db, origin, compiler });
  const { extensionId: itemId } = admitTaskDraft(db, createLifecycle(db));
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  return { db, call, itemId, async login(userId = 'maya') {
    const bootstrap = (await call('session')).json();
    const response = await call('session', { userId }, { 'x-session-context': bootstrap.contextToken });
    assert.equal(response.statusCode, 200);
    auth = { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
  } };
}

test('rename accepts trimmed Unicode code points and rejects malformed or unsupported input', async t => {
  const { db, call, login, itemId } = await api(t);
  await login();
  let state = (await call(`extensions/${itemId}`)).json();
  const path = `extensions/${state.extension.id}/rename`;
  const before = snapshot(db);
  for (const body of [null, [], {}, { name: 'Name' }, { expectedName: state.extension.name },
    { name: 'Name', expectedName: state.extension.name, owner: 'leo' },
    { name: 'Name', expectedName: ' '.repeat(80) + state.extension.name },
    ...['\0Name', 'Na\0me'].map(name => ({ name, expectedName: state.extension.name })),
    ...[null, 1, '', ' \t\n\u00a0 ', '\ud800', '\udc00', 'A\ud800B', 'a'.repeat(81), '😀'.repeat(81)]
      .flatMap(value => [{ name: value, expectedName: state.extension.name }, { name: 'Name', expectedName: value }])]) {
    assert.equal((await call(path, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await call(path + '?owner=leo', { name: 'Name', expectedName: state.extension.name })).statusCode, 400);
  assert.deepEqual(snapshot(db), before);
  for (const name of ['  שלום – 日本語 😀  ', '😀'.repeat(80), 'e\u0301'.repeat(40)]) {
    const response = await call(path, { name, expectedName: state.extension.name });
    assert.equal(response.statusCode, 200, response.body);
    state = response.json();
    assert.equal(state.extension.name, name.trim());
    assert.deepEqual(state, (await call(`extensions/${state.extension.id}`)).json());
  }
});

test('rename enforces owner, exact item, session, origin and compare-before-no-op fences', async t => {
  const { db, call, login, itemId } = await api(t);
  await login();
  const initial = (await call(`extensions/${itemId}`)).json(), id = initial.extension.id;
  const path = `extensions/${id}/rename`, input = { name: 'Clear name', expectedName: initial.extension.name };
  const before = snapshot(db);
  assert.equal((await call(path, input, { origin: 'https://foreign.example' })).statusCode, 403);
  assert.equal((await call(path, input, { 'x-session-context': 'stale' })).statusCode, 401);
  assert.equal((await call('extensions/missing/rename', input)).statusCode, 404);
  await login('leo');
  assert.equal((await call(path, input)).statusCode, 404);
  assert.deepEqual(snapshot(db), before);
  await login();
  const attempts = await Promise.all([call(path, input), call(path, { ...input, name: 'Another name' })]);
  assert.deepEqual(attempts.map(response => response.statusCode).sort(), [200, 409]);
  const current = (await call(`extensions/${id}`)).json(), after = snapshot(db);
  onlyNameChanged(before, after, id, current.extension.name);
  assert.equal((await call(path, { name: current.extension.name, expectedName: initial.extension.name })).statusCode, 409,
    'a stale expected name conflicts even when the requested name is already current');
  assert.equal((await call(path, { name: current.extension.name, expectedName: ' ' + current.extension.name })).statusCode, 409,
    'expectedName is compared exactly');
  const changes = db.prepare('SELECT total_changes() n').get().n;
  const noOp = await call(path, { name: ' ' + current.extension.name + ' ', expectedName: current.extension.name });
  assert.equal(noOp.statusCode, 200);
  assert.deepEqual(noOp.json(), current);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'matching rename performs no write');
  assert.deepEqual(snapshot(db), after);
});

test('rename preserves authored revisions, proof, approval, active generation and persistence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-extension-naming-')), path = join(directory, 'app.sqlite');
  let db = openData(path);
  t.after(() => {
    db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  let lifecycle = createLifecycle(db, { compiler });
  const fixture = await compileTaskCustomization();
  const { extensionId: id } = admitTaskDraft(db, lifecycle, { operationId: 'named-source', name: 'Existing name' });
  let state = await lifecycle.compile('maya', { extensionId: id, hookId: 'TaskCompleted', source: fixture.source, draftVersion: 0 }, authorized);
  state = await lifecycle.proposeScenarios('maya', { extensionId: id, revisionId: state.revisionId, draftVersion: state.draftVersion, cases: fixture.cases }, authorized);
  const input = { extensionId: id, revisionId: state.revisionId, draftVersion: state.draftVersion };
  state = await lifecycle.simulate('maya', input, authorized);
  state = lifecycle.approve('maya', { ...input, evidenceId: state.evidence.id }, authorized);
  state = lifecycle.activate('maya', { ...input, generation: state.selection.generation }, authorized);
  const before = snapshot(db);
  let checks = 0;
  assert.throws(() => lifecycle.rename('maya', { extensionId: id, name: 'Rejected', expectedName: state.extension.name }, () => {
    assert.equal(db.isTransaction, true);
    if (++checks === 2) throw new AppError(401, 'Session changed.');
  }), { status: 401 });
  assert.equal(checks, 2);
  assert.deepEqual(snapshot(db), before, 'authorization loss rolls the metadata write back');
  const renamed = lifecycle.rename('maya', { extensionId: id, name: 'New explicit name', expectedName: state.extension.name }, authorized);
  onlyNameChanged(before, snapshot(db), id, 'New explicit name');
  assert.equal(renamed.approved, true);
  assert.equal(renamed.approvedEvidenceId, state.approvedEvidenceId);
  assert.equal(renamed.selection.revision.id, state.selection.revision.id);
  assert.equal(renamed.selection.generation, state.selection.generation);
  const saved = snapshot(db);
  db.close(); db = openData(path); lifecycle = createLifecycle(db, {});
  assert.deepEqual(snapshot(db), saved);
  assert.deepEqual(lifecycle.state('maya', id), renamed);
});

test('rename accepts exact embedded-NUL legacy preconditions while rejecting NUL in new names', async t => {
  const { db, call, login, itemId } = await api(t);
  await login();
  const state = (await call(`extensions/${itemId}`)).json(), id = state.extension.id, legacy = 'Legacy\0name';
  db.prepare('UPDATE extensions SET name=? WHERE owner_id=? AND id=?').run(legacy, 'maya', id);
  const path = `extensions/${id}/rename`, before = snapshot(db);
  const saved = (await call(`extensions/${id}`)).json();
  assert.equal(saved.extension.name, legacy, 'existing metadata is never backfilled');
  assert.equal(saved.extension.name, legacy, 'historical metadata bytes remain exact on the task item');
  assert.equal(Buffer.from(db.prepare('SELECT CAST(name AS BLOB) name FROM extensions WHERE id=?').get(id).name).toString('utf8'), legacy);
  assert.equal((await call(path, { name: 'Clear legacy name', expectedName: 'Legacy' })).statusCode, 409);
  assert.equal((await call(path, { name: legacy, expectedName: legacy })).statusCode, 400, 'new names reject embedded NUL even as a no-op');
  assert.deepEqual(snapshot(db), before);
  assert.equal(Buffer.from(db.prepare('SELECT CAST(name AS BLOB) name FROM extensions WHERE id=?').get(id).name).toString('utf8'), legacy,
    'rejected renames preserve the original bytes beyond the embedded NUL');
  const renamed = await call(path, { name: 'Clear legacy name', expectedName: legacy });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().extension.name, 'Clear legacy name');
  onlyNameChanged(before, snapshot(db), id, 'Clear legacy name');
  assert.equal((await call(path, { name: 'Clear legacy name', expectedName: legacy })).statusCode, 409, 'stale legacy precondition conflicts before no-op');
  assert.equal((await call(path, { name: 'Clear legacy name', expectedName: 'Clear legacy name' })).statusCode, 200);
});

test('legacy names and source stay readable while rename and new direct-source creation remain retired', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db);
  t.after(() => db.close());
  const legacy = lifecycle.state('maya', lifecycle.collection('maya').items[0].extension.id);
  const before = snapshot(db), source = lifecycle.source('maya', legacy.selection.revision.id, legacy.extension.id);
  assert.equal(legacy.retired, true);
  assert.throws(() => lifecycle.rename('maya', { extensionId: legacy.extension.id, name: 'New legacy name', expectedName: legacy.extension.name }, authorized),
    { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  await assert.rejects(lifecycle.createFromSource('maya', { operationId: 'retired-source', source: source.source }, authorized),
    { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.deepEqual(lifecycle.source('maya', legacy.selection.revision.id, legacy.extension.id), source);
  assert.deepEqual(snapshot(db), before);
});

test('AI creation uses a neutral name without backfilling existing names or changing creation deduplication', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler });
  const existing = db.prepare('SELECT id,name FROM extensions ORDER BY id').all();
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-test-key' });
  let providerCalls = 0; const providerRequests = [];
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: value => ({ reserveMicros: value.reserveMicros,
    maxMicros: value.maxMicros, async complete(args) {
      providerRequests.push(args);
      providerCalls++;
      if (providerCalls === 1) return { calls: [{ id: 'discover-naming', name: 'discover_catalog', arguments: {} }], text: '', usage: { inputTokens: 8, outputTokens: 4 } };
      return { calls: [], text: 'What would you like to customize?', usage: { inputTokens: 8, outputTokens: 4 } };
    } }) });
  t.after(async () => { await service.close(); db.close(); });
  const lease = { sessionId: 'naming-session', current: () => true };
  const request = { conversationId: null, operationId: 'neutral-create', text: 'A long business request that must never become the saved customization name.',
    expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } };
  const accepted = await service.turn('maya', request, lease);
  await service.wait('maya', accepted.conversation.id);
  const id = accepted.conversation.extensionId;
  assert.equal(lifecycle.state('maya', id).extension.name, 'Untitled customization');
  assert.equal(lifecycle.collection('maya').items.find(item => item.extension.id === id).requestExcerpt, request.text);
  assert.equal(Object.hasOwn(lifecycle.state('maya', id), 'requestExcerpt'), false);
  assert.equal(JSON.stringify(providerRequests).includes('requestExcerpt'), false, 'collection metadata never enters provider discovery or context');
  assert.deepEqual(db.prepare('SELECT id,name FROM extensions WHERE id<>? ORDER BY id').all(id), existing);
  const before = snapshot(db), calls = providerCalls;
  const renamed = lifecycle.rename('maya', { extensionId: id, name: 'Chosen name', expectedName: 'Untitled customization' }, authorized);
  onlyNameChanged(before, snapshot(db), id, 'Chosen name');
  assert.equal(providerCalls, calls, 'rename never calls the provider');
  const afterRename = snapshot(db);
  const duplicate = await service.turn('maya', request, lease);
  assert.equal(duplicate.conversation.extensionId, id);
  assert.deepEqual(duplicate.operation, accepted.operation);
  assert.equal(lifecycle.state('maya', id).extension.name, renamed.extension.name);
  assert.equal(providerCalls, calls);
  assert.deepEqual(snapshot(db), afterRename, 'creation replay preserves the explicit name and accounting');
  await assert.rejects(service.turn('maya', { ...request, text: 'Different request' }, lease), { status: 409 });
  assert.deepEqual(snapshot(db), afterRename);
});

test('collection excerpts require unique original owner/item creation linkage and bound Unicode text', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler });
  t.after(() => db.close());
  const item = transaction(db, () => lifecycle.admit('maya', { extensionId: 'excerpt-item', operationId: 'excerpt-create', hash: digest('TEST historical admission'), name: 'Untitled customization' }, authorized));
  const id = item.extension.id, original = '  Unsupported calendar request 😀 ' + '😀'.repeat(170) + '  ';
  const messages = [{ id: 'excerpt-create', role: 'user', text: original },
    { id: 'later-request', role: 'user', text: 'Later discussion must not replace the original.' }];
  const addConversation = (conversationId, operationId, owner = 'maya') => {
    db.prepare(`INSERT INTO authoring_conversations(id,owner_id,creation_operation_id,version,run_id,status,cancel_requested,updated_at,state,operations,view,created_at)
      VALUES(?,?,?,0,?,'IDLE',0,0,'{"createdAt":0}','[]','{"messages":[]}',0)`).run(conversationId, owner, operationId, 'fixture-run');
    for (const [index, message] of messages.entries()) db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)')
      .run(conversationId, owner, index + 1, message.id, JSON.stringify(message));
  };
  const link = (conversationId, purpose = 'CREATE') => db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,NULL,NULL)')
    .run(conversationId, 'maya', id, purpose);
  const read = () => lifecycle.collection('maya').items.find(value => value.extension.id === id);
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false, 'source-only and migrated items have no guessed excerpt');
  addConversation('excerpt-conversation', 'excerpt-create'); link('excerpt-conversation');
  const before = snapshot(db);
  assert.equal(read().requestExcerpt, Array.from(original.trim()).slice(0, 160).join(''));
  assert.equal(Array.from(read().requestExcerpt).length, 160);
  assert.deepEqual(snapshot(db), before, 'excerpt reads make no persisted changes');
  assert.equal(JSON.stringify(lifecycle.collection('leo')).includes('Unsupported calendar'), false);
  assert.equal(Object.hasOwn(lifecycle.state('maya', id), 'requestExcerpt'), false);
  db.prepare("UPDATE extension_conversation_links SET purpose='REVISE' WHERE conversation_id=?").run('excerpt-conversation');
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false, 'revision discussions never supply creation intent');
  db.prepare("UPDATE extension_conversation_links SET purpose='CREATE' WHERE conversation_id=?").run('excerpt-conversation');
  db.prepare('UPDATE authoring_conversations SET creation_operation_id=? WHERE id=?').run('mismatched-operation', 'excerpt-conversation');
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false);
  db.prepare('UPDATE authoring_conversations SET creation_operation_id=? WHERE id=?').run('excerpt-create', 'excerpt-conversation');
  addConversation('ambiguous-conversation', 'another-operation'); link('ambiguous-conversation');
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false, 'multiple CREATE links remain ambiguous even if one operation matches');
  db.prepare('DELETE FROM extension_conversation_links WHERE conversation_id=?').run('ambiguous-conversation');
  for (const payload of ['not json', '{}', JSON.stringify({ id: 'wrong-operation', role: 'user', text: 'Wrong original' }),
    JSON.stringify({ id: 'excerpt-create', role: 'user', text: '\ud800' })]) {
    db.prepare('DELETE FROM authoring_messages WHERE conversation_id=?').run('excerpt-conversation');
    db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run('excerpt-conversation', 'maya', 1, 'excerpt-create', payload);
    assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false, 'malformed or unproven messages are omitted');
  }
});
