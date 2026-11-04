import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { loadCatalog } from '../src/extension-catalog.mjs';
import { digest } from '../src/extension-catalog.mjs';

const origin = 'http://127.0.0.1:32123';
const source = readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8');
const artifact = loadCatalog().find(item => item.id === 'pending').artifactBytes;
const compiler = { compile: async () => ({ artifact, diagnostics: [] }) };
const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-test-key' });
const response = (call, text = '') => ({ calls: call ? [call] : [], text, usage: { inputTokens: 8, outputTokens: 4 } });
const call = (name, id, arguments_ = {}) => ({ id, name, arguments: arguments_ });

function scriptedProvider({ onCall = () => {}, question = 'Would task advice while checking a saved task help instead?' } = {}) {
  const requests = [];
  const providerFactory = value => {
    let step = 0, compileRequested = false;
    return {
      reserveMicros: value.reserveMicros,
      maxMicros: value.maxMicros,
      async complete(args) {
        requests.push(args); onCall(args);
        const n = step++;
        if (compileRequested) return response(null, 'The supported advice is prepared as a draft for your review.');
        if (typeof args.input === 'string' && /^no\b/i.test(args.input)) return response(null, 'No changes were made.');
        if (typeof args.input === 'string' && /\byes\b|\bagree\b/i.test(args.input)) {
          compileRequested = true;
          return response(call('compile_draft', 'compile-' + requests.length, { sourceJson: source, expectedDraftVersion: 0 }));
        }
        if (n === 0) return response(call('discover_catalog', 'discover-' + requests.length));
        if (n === 1) return response(call('ask_clarification', 'clarify-' + requests.length, { question }));
        return response(null, 'I am waiting for your choice.');
      },
    };
  };
  return { providerFactory, requests };
}

async function api(t, { provider, checkpointFault, compiler: appCompiler = compiler } = {}) {
  const db = openData(':memory:');
  const app = await createApp({ db, origin, compiler: appCompiler, authoring: {
    config, providerFactory: provider?.providerFactory ?? scriptedProvider().providerFactory, checkpointFault,
  } });
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const callApi = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  return { db, call: callApi, getAuth: () => ({ ...auth }), async login(userId = 'maya') {
    const bootstrap = (await callApi('session')).json();
    const signedIn = await callApi('session', { userId }, { 'x-session-context': bootstrap.contextToken });
    assert.equal(signedIn.statusCode, 200);
    auth = { cookie: signedIn.headers['set-cookie'].split(';')[0], 'x-session-context': signedIn.json().contextToken };
  } };
}

const start = (operationId, text, target = { kind: 'create' }, overrides = {}) => ({
  conversationId: null, operationId, text, expectedVersion: 0, expectedDraftVersion: 0, target, ...overrides,
});
async function settled(callApi, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await callApi(`authoring/conversations/${id}`);
    assert.equal(response.statusCode, 200);
    const conversation = response.json();
    if (!['RUNNING', 'CANCELLING'].includes(conversation.status)) return conversation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The synthetic authoring turn did not settle.');
}
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

test('create admission, item-filtered reads, deduplication, stale resume and explicit revise stay scoped', async t => {
  const admitSnapshots = [], providerSnapshots = [];
  const provider = scriptedProvider({ onCall: args => providerSnapshots.push({
    budget: db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros,
    linked: count(db, "SELECT count(*) n FROM extension_conversation_links WHERE owner_id='maya'"),
    args,
  }) });
  const { db, call: callApi, login } = await api(t, { provider, checkpointFault: point => {
    if (point.stage === 'afterCommit' && point.phase === 'ADMIT') {
      const row = db.prepare(`SELECT e.id,e.hook_id,e.draft_version,e.draft_revision_id,c.id conversation_id,l.purpose
        FROM extensions e JOIN extension_conversation_links l ON l.extension_id=e.id
        JOIN authoring_conversations c ON c.id=l.conversation_id WHERE c.creation_operation_id=?`).get('create-chat');
      admitSnapshots.push({ row: row && { ...row }, budget: db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros });
    }
  } });
  await login();
  const initial = (await callApi('extensions')).json();
  const baselineCount = count(db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'");
  assert.equal((await callApi('authoring')).json().current, null);
  assert.equal((await callApi(`authoring?extensionId=${initial.items[0].extension.id}`)).json().current, null);
  assert.equal((await callApi(`extensions/${initial.items[0].extension.id}`)).json().extension.id, initial.items[0].extension.id);
  assert.equal(count(db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'"), baselineCount, 'GET reads allocate nothing');

  const legacyFiveField = { conversationId: null, operationId: 'old-request', text: 'Help me.', expectedVersion: 0, expectedDraftVersion: 0 };
  assert.equal((await callApi('authoring/turn', legacyFiveField)).statusCode, 400);
  assert.equal((await callApi('extensions/compile', { source, draftVersion: 0 })).statusCode, 404, 'old unscoped mutation route is gone');
  assert.equal(count(db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'"), baselineCount);
  assert.equal(count(db, 'SELECT count(*) n FROM authoring_conversations'), 0);

  const request = start('create-chat', 'Help me make a useful task extension.');
  assert.equal(Object.keys(request).length, 6);
  const created = await callApi('authoring/turn', request);
  assert.equal(created.statusCode, 202);
  const conversationId = created.json().conversation.id;
  const conversation = await settled(callApi, conversationId);
  assert.equal(conversation.status, 'AWAITING_USER');
  assert.equal(conversation.purpose, 'CREATE');
  assert.ok(conversation.extensionId);
  assert.deepEqual(conversation.draft, { revisionId: null, draftVersion: 0, suiteDigest: null });
  assert.deepEqual(admitSnapshots[0], { row: { id: conversation.extensionId, hook_id: null, draft_version: 0,
    draft_revision_id: null, conversation_id: conversationId, purpose: 'CREATE' }, budget: 0 });
  assert.equal(providerSnapshots[0].budget, config.reserveMicros, 'the linked blank item exists before the first provider dispatch');
  assert.equal(providerSnapshots[0].linked, 1, 'the first provider call sees the committed conversation link');
  const discovery = JSON.parse(provider.requests[1].toolResult.output).result;
  assert.equal(discovery.purpose, 'CREATE');
  assert.equal(discovery.currentDraft.revisionId, null);
  assert.equal(discovery.currentDraft.draftVersion, 0);
  assert.equal(discovery.currentProposal, null, 'new creation does not inherit the seeded advice');
  assert.ok(discovery.supportedHooks.some(item => item.id === 'ClassifyTask'));

  const blank = (await callApi(`extensions/${conversation.extensionId}`)).json();
  assert.equal(blank.extension.hookId, null);
  assert.equal(blank.revisionId, null);
  const filtered = (await callApi(`authoring?extensionId=${conversation.extensionId}`)).json();
  assert.equal(filtered.current.extensionId, conversation.extensionId);
  assert.equal(filtered.current.purpose, 'CREATE');
  assert.ok(filtered.conversations.every(item => item.extensionId === conversation.extensionId));
  assert.equal((await callApi('authoring')).json().current, null);

  const compiled = await callApi(`extensions/${conversation.extensionId}/compile`, { source, draftVersion: 0 });
  assert.equal(compiled.statusCode, 200);
  assert.equal(compiled.json().draftVersion, 1);
  assert.equal(compiled.json().extension.hookId, 'ClassifyTask');
  const requestCount = provider.requests.length;
  const heldBeforeReplay = db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
  const replay = await callApi('authoring/turn', request);
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().conversation.id, conversationId);
  assert.deepEqual(replay.json().operation, created.json().operation);
  assert.equal(provider.requests.length, requestCount, 'creation replay reads its receipt before checking the advanced head');
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, heldBeforeReplay);
  assert.equal((await callApi('authoring/turn', { ...request, text: 'Different creation intent.' })).statusCode, 409);
  assert.equal((await callApi('authoring/turn', start('stale-resume', 'Continue the old draft.', { kind: 'resume', extensionId: conversation.extensionId }, {
    conversationId, expectedVersion: conversation.version, expectedDraftVersion: 0,
  }))).statusCode, 409);
  assert.equal((await callApi('authoring/turn', start('unknown-resume', 'Continue.', { kind: 'resume', extensionId: 'missing-item' }, {
    conversationId, expectedVersion: conversation.version, expectedDraftVersion: 1,
  }))).statusCode, 404);

  const revised = await callApi('authoring/turn', start('new-revise', 'Help me revise this task advice.', {
    kind: 'revise', extensionId: conversation.extensionId, baseRevisionId: compiled.json().draft.id,
    selectionGeneration: compiled.json().selection.generation,
  }, { expectedDraftVersion: 1 }));
  assert.equal(revised.statusCode, 202);
  const reviseConversation = await settled(callApi, revised.json().conversation.id);
  assert.equal(reviseConversation.purpose, 'REVISE');
  const link = db.prepare('SELECT extension_id,purpose,base_revision_id,base_generation FROM extension_conversation_links WHERE conversation_id=?').get(reviseConversation.id);
  assert.deepEqual({ ...link }, { extension_id: conversation.extensionId, purpose: 'REVISE', base_revision_id: compiled.json().draft.id,
    base_generation: compiled.json().selection.generation });

  const secondItem = await callApi('extensions', { operationId: 'second-item', source, label: 'Second item' });
  assert.equal(secondItem.statusCode, 200);
  assert.notEqual(secondItem.json().extension.id, conversation.extensionId);
  const mismatch = await callApi('authoring/turn', start('wrong-resume-item', 'Continue.', { kind: 'resume', extensionId: secondItem.json().extension.id }, {
    conversationId, expectedVersion: conversation.version, expectedDraftVersion: 1,
  }));
  assert.equal(mismatch.statusCode, 404);
});

test('foreign targets fail and an unlinked legacy chat stays readable but cannot resume', async t => {
  const { db, call: callApi, login } = await api(t);
  await login();
  const own = await callApi('extensions', { operationId: 'own-item', source, label: 'Owned item' });
  assert.equal(own.statusCode, 200);
  const ownId = own.json().extension.id;
  await login('leo');
  const foreign = await callApi('extensions', { operationId: 'foreign-item', source, label: 'Other owner item' });
  assert.equal(foreign.statusCode, 200);
  const foreignId = foreign.json().extension.id;
  await login('maya');
  const before = { extensions: count(db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'"),
    conversations: count(db, "SELECT count(*) n FROM authoring_conversations WHERE owner_id='maya'"),
    budget: db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros };
  assert.equal((await callApi(`extensions/${foreignId}`)).statusCode, 404);
  const foreignTarget = await callApi('authoring/turn', start('foreign-item-target', 'Revise this item.', {
    kind: 'revise', extensionId: foreignId, baseRevisionId: null, selectionGeneration: 1,
  }));
  assert.equal(foreignTarget.statusCode, 404);
  assert.deepEqual({ extensions: count(db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'"),
    conversations: count(db, "SELECT count(*) n FROM authoring_conversations WHERE owner_id='maya'"),
    budget: db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros }, before);

  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-chat', 'maya', 'legacy-operation', 1,
    'legacy-run', 'AWAITING_USER', 0, 123, JSON.stringify({ handles: { revisionId: null, draftVersion: 0, suiteDigest: null } }),
    JSON.stringify([{ id: 'legacy-operation', runId: 'legacy-run', version: 1 }]), JSON.stringify({ messages: [], code: null, review: null }), 123);
  const read = await callApi('authoring/conversations/legacy-chat');
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().extensionId, null);
  assert.equal(read.json().purpose, null);
  const resume = await callApi('authoring/turn', start('legacy-resume', 'Continue old work.', { kind: 'resume', extensionId: ownId }, {
    conversationId: 'legacy-chat', expectedVersion: 1,
  }));
  assert.equal(resume.statusCode, 404);
  assert.equal((await callApi('authoring')).json().current, null);
  assert.equal((await callApi(`authoring?extensionId=${ownId}`)).json().current, null);
});

test('unsupported requests wait for a decision; refusal leaves no program, assent can compile only a draft', async t => {
  let compileCalls = 0;
  const countedCompiler = { compile: async () => { compileCalls++; return { artifact, diagnostics: [] }; } };
  const { db, call: callApi, login } = await api(t, { provider: scriptedProvider({ question: 'Only task-status advice is available. Would that help?' }),
    compiler: countedCompiler });
  await login();
  const selectionBefore = (await callApi('extensions')).json().selection;
  const unsupported = await callApi('authoring/turn', start('unsupported-create', 'Send a weekly email automatically.'));
  assert.equal(unsupported.statusCode, 202);
  const pending = await settled(callApi, unsupported.json().conversation.id);
  assert.equal(pending.status, 'AWAITING_USER');
  assert.match(pending.messages.at(-1).text, /Only task-status advice/);
  let blank = (await callApi(`extensions/${pending.extensionId}`)).json();
  assert.equal(blank.revisionId, null);
  assert.equal(blank.extension.hookId, null);
  assert.equal(blank.approved, false);
  assert.equal(compileCalls, 0);

  const refused = await callApi('authoring/turn', start('unsupported-refusal', 'No, that alternative is not useful.', {
    kind: 'resume', extensionId: pending.extensionId,
  }, { conversationId: pending.id, expectedVersion: pending.version }));
  assert.equal(refused.statusCode, 202);
  assert.equal((await settled(callApi, pending.id)).status, 'IDLE');
  blank = (await callApi(`extensions/${pending.extensionId}`)).json();
  assert.equal(blank.revisionId, null);
  assert.equal(blank.extension.hookId, null);
  assert.equal(blank.approved, false);
  assert.equal(count(db, 'SELECT count(*) n FROM extension_approvals'), 0);
  assert.deepEqual((await callApi('extensions')).json().selection, selectionBefore);

  const assent = await callApi('authoring/turn', start('assent-create', 'Help me give useful task advice.'));
  assert.equal(assent.statusCode, 202);
  const awaitingAssent = await settled(callApi, assent.json().conversation.id);
  assert.equal(awaitingAssent.status, 'AWAITING_USER');
  const compiled = await callApi('authoring/turn', start('explicit-assent', 'Yes, showing advice while I check is useful.', {
    kind: 'resume', extensionId: awaitingAssent.extensionId,
  }, { conversationId: awaitingAssent.id, expectedVersion: awaitingAssent.version }));
  assert.equal(compiled.statusCode, 202);
  assert.equal((await settled(callApi, awaitingAssent.id)).status, 'IDLE');
  const draft = (await callApi(`extensions/${awaitingAssent.extensionId}`)).json();
  assert.equal(draft.extension.hookId, 'ClassifyTask');
  assert.ok(draft.revisionId);
  assert.equal(draft.evidence, null);
  assert.equal(draft.approved, false);
  assert.equal(compileCalls, 1, 'only the explicit assent triggers compilation');
  assert.deepEqual((await callApi('extensions')).json().selection, selectionBefore);
});

test('ADMIT rollback leaves no item/chat/credit; post-commit uncertainty preserves the original receipt', async t => {
  const before = await api(t, { checkpointFault: point => {
    if (point.stage === 'beforeCommit' && point.phase === 'ADMIT') throw new Error('injected transaction failure');
  } });
  await before.login();
  const initialItems = count(before.db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'");
  const rejected = await before.call('authoring/turn', start('rollback-create', 'Create a task extension.'));
  assert.equal(rejected.statusCode, 503);
  assert.equal(count(before.db, "SELECT count(*) n FROM extensions WHERE owner_id='maya'"), initialItems);
  assert.equal(count(before.db, 'SELECT count(*) n FROM authoring_conversations'), 0);
  assert.equal(count(before.db, 'SELECT count(*) n FROM extension_conversation_links'), 0);
  assert.equal(before.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 0);

  let providerCalls = 0, failedOnce = false;
  const provider = scriptedProvider({ onCall: () => { providerCalls++; } });
  const after = await api(t, { provider, checkpointFault: point => {
    if (!failedOnce && point.stage === 'afterCommit' && point.phase === 'ADMIT') { failedOnce = true; throw new Error('lost commit receipt'); }
  } });
  await after.login();
  const request = start('uncertain-create', 'Create another task extension.');
  const admitted = await after.call('authoring/turn', request);
  assert.equal(admitted.statusCode, 202);
  const first = await settled(after.call, admitted.json().conversation.id);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(providerCalls, 0);
  assert.equal(count(after.db, 'SELECT count(*) n FROM extensions WHERE creation_operation_id=?', request.operationId), 1);
  assert.equal(count(after.db, 'SELECT count(*) n FROM extension_conversation_links WHERE conversation_id=?', first.id), 1);
  assert.equal(after.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 0);
  const retry = await after.call('authoring/turn', request);
  assert.equal(retry.statusCode, 202);
  assert.equal(retry.json().conversation.id, first.id);
  assert.deepEqual(retry.json().operation, admitted.json().operation);
  assert.equal(providerCalls, 0);
  assert.equal(count(after.db, 'SELECT count(*) n FROM extensions WHERE creation_operation_id=?', request.operationId), 1);
});
