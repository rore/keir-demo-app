import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openData, taskService, transaction } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createAuthoringState } from '../src/authoring-agent.mjs';
import { digest, json, loadHost, TASK_DEFINITION } from '../src/extension-catalog.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const snapshot = db => Object.fromEntries(['extension_revisions', 'extension_authored', 'extension_evidence', 'extension_approvals',
  'extension_history', 'extension_selections', 'extensions', 'authoring_budget'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('old unbound task conversations remain retired while fresh definition admission stays repairable', async t => {
  const db = openData(':memory:'); t.after(() => db.close());
  let compiles = 0;
  const lifecycle = createLifecycle(db, { compiler: { compile() { compiles++; throw Object.assign(new Error('Unavailable compiler'), { status: 503 }); } } });
  const old = admitTaskDraft(db, lifecycle, { extensionId: 'old-unbound-task' });
  const original = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(old.conversationId).state);
  db.prepare('UPDATE authoring_conversations SET state=? WHERE id=?').run(JSON.stringify({ ...original, definitionId: 'daymark.task-completed/1' }), old.conversationId);
  const before = snapshot(db);
  assert.equal(lifecycle.state('maya', old.extensionId).retired, true);
  await assert.rejects(lifecycle.compile('maya', { extensionId: old.extensionId, hookId: 'TaskCompleted', source: '{}', draftVersion: 0 }, () => {}),
    { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.equal(compiles, 0); assert.deepEqual(snapshot(db), before);

  assert.equal(TASK_DEFINITION, 'daymark.task-completed/2');
  const fresh = admitTaskDraft(db, lifecycle, { extensionId: 'new-unbound-task' });
  await assert.rejects(lifecycle.compile('maya', { extensionId: fresh.extensionId, hookId: 'TaskCompleted', source: '{}', draftVersion: 0 }, () => {}), { status: 503 });
  const retained = lifecycle.state('maya', fresh.extensionId);
  assert.equal(retained.retired, false); assert.equal(retained.draftVersion, 0); assert.equal(retained.draft, null);
});

test('raw effect3 source and exact passing approval survive definition replacement without execution authority', async t => {
  const db = openData(':memory:'); t.after(() => db.close());
  const load = name => readFileSync(new URL(`./fixtures/task-effect-3/${name}.json`, import.meta.url));
  const source = load('source'), artifact = load('artifact'), scenarios = JSON.parse(load('cases'));
  const saved = JSON.parse(load('reports')), { simulator, ...dependencies } = saved.identity;
  assert.equal(saved.status, 'PASS'); assert.equal(dependencies.profile, 'keir-effect/3');
  assert.equal(JSON.parse(artifact).format, 'keir-artifact/effect-3');
  assert.equal(loadHost('TaskCompleted').pins.profile, 'keir-effect/4');
  const suite = json(scenarios), pins = { ...dependencies, rawSourceDigest: digest(source),
    compiledSourceDigest: JSON.parse(artifact).sourceDigest, suiteDigest: digest(suite) };
  const identity = json(pins), versions = { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator };
  const suiteIdentity = digest(json({ ...versions, simulator: identity,
    cases: scenarios.map(text => ({ id: JSON.parse(text).id, digest: digest(text) })) }));
  const payload = json({ identity: { dependencies: pins, ...versions, suiteDigest: suiteIdentity }, reports: saved.reports });
  const lifecycle = createLifecycle(db), extensionId = 'historical-effect3-item', revisionId = 'historical-effect3-revision', proofId = 'historical-effect3-proof';
  const binding = json({ ...pins, approvedEvidenceId: proofId, qualification: { id: 'historical-audit-only' } });
  transaction(db, () => {
    lifecycle.admit('maya', { extensionId, operationId: extensionId, hash: digest(extensionId), name: 'Historical task customization' }, () => {});
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, 'maya', 'authored', identity, 'customer');
    db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revisionId, 'maya', 'Historical task customization', source, artifact, suite);
    db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, 'maya', extensionId);
    db.prepare('UPDATE extensions SET hook_id=?,draft_revision_id=?,draft_version=1 WHERE id=?').run('TaskCompleted', revisionId, extensionId);
    db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run(proofId, 'maya', revisionId, identity, suiteIdentity, payload, 1);
    db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('maya', revisionId, proofId);
    db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id='maya' AND hook_id='TaskCompleted'").run(revisionId, binding);
    db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run('maya', revisionId, 1, 'activate');
  });
  const before = snapshot(db), native = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const state = lifecycle.state('maya', extensionId), raw = lifecycle.source('maya', revisionId, extensionId);
  assert.equal(state.retired, true); assert.equal(state.approved, true); assert.equal(state.approvedEvidenceId, proofId);
  assert.equal(state.selection.eligible, false); assert.equal(state.selection.approvedEvidenceId, proofId);
  assert.equal(raw.source, source.toString('utf8')); assert.equal(raw.artifact, artifact.toString('utf8')); assert.deepEqual(raw.cases, scenarios);
  assert.equal(lifecycle.evidence('maya', proofId, extensionId).passed, true);
  assert.equal(lifecycle.capture('maya'), null);
  assert.equal(lifecycle.admissionCurrent({ owner: 'maya', itemId: extensionId, revisionId, pins: JSON.parse(binding) }), false);
  assert.throws(() => lifecycle.execution('maya', revisionId, extensionId), { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  for (const operation of ['activate', 'rollback', 'restart']) assert.throws(() => lifecycle[operation]('maya',
    { extensionId, revisionId, draftVersion: 1, generation: 1 }, () => {}), { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.throws(() => lifecycle.source('leo', revisionId, extensionId), { status: 404 });
  assert.deepEqual(snapshot(db), before); assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), native);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  db.prepare('UPDATE extension_authored SET source=? WHERE revision_id=?').run(Buffer.concat([source, Buffer.from('\n')]), revisionId);
  assert.throws(() => lifecycle.source('maya', revisionId, extensionId), { status: 404 });
  assert.equal(lifecycle.state('maya', extensionId).approved, false);
});

test('every retired mutation route returns explicit retirement while original source and history stay readable', async t => {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32973';
  const app = await createApp({ db, origin });
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32973', origin, 'content-type': 'application/json', ...auth }, ...(payload === undefined ? {} : { payload }) });
  const context = (await call('session')).json().contextToken;
  auth['x-session-context'] = context;
  const login = await call('session', { userId: 'maya' });
  auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-session-context': login.json().contextToken };
  const item = db.prepare("SELECT id FROM extensions WHERE owner_id='maya'").get().id;
  const revision = db.prepare("SELECT id FROM extension_revisions WHERE owner_id='maya'").get().id;
  const before = snapshot(db);
  for (const operation of ['draft', 'compile', 'scenarios', 'simulate', 'approve', 'activate', 'rollback', 'restart']) {
    const response = await call(`extensions/${item}/${operation}`, { hookId: 'TaskCompleted', revisionId: revision, draftVersion: 0, generation: 1 });
    assert.equal(response.statusCode, 410, operation);
    assert.equal(response.json().code, 'LEGACY_CUSTOMIZATION_RETIRED', operation);
  }
  assert.equal((await call(`extensions/${item}`)).json().retired, true);
  const source = await call(`extensions/${item}/revisions/${revision}`);
  assert.equal(source.statusCode, 200); assert.ok(source.json().source); assert.ok(source.json().artifact);
  assert.equal((await call(`extensions/${item}/history`)).statusCode, 200);
  assert.equal((await call(`extensions/${item}/revisions`)).statusCode, 200);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_completion_events').get().n, 0);
  const disabled = await call(`extensions/${item}/disable`, { generation: 1 });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().selection.revision, null);
  assert.deepEqual(snapshot(db).extension_revisions, before.extension_revisions);
});

test('original direct-source receipt and mismatch recovery precede retirement without new compile or item', async t => {
  const db = openData(':memory:'); t.after(() => db.close());
  let compiles = 0;
  const lifecycle = createLifecycle(db, { compiler: { compile() { compiles++; throw new Error('Retired source must not compile'); } } });
  const item = db.prepare("SELECT id FROM extensions WHERE owner_id='maya'").get().id;
  const request = { operationId: 'historical-source-operation', source: 'original historical source', label: 'Historical source' };
  db.prepare('UPDATE extensions SET creation_operation_id=?,creation_hash=? WHERE id=?').run(request.operationId, digest(json(request)), item);
  const before = snapshot(db);
  const recovered = await lifecycle.createFromSource('maya', request, () => {});
  assert.equal(recovered.extension.id, item); assert.equal(recovered.retired, true);
  await assert.rejects(lifecycle.createFromSource('maya', { ...request, source: 'changed' }, () => {}), { status: 409 });
  await assert.rejects(lifecycle.createFromSource('maya', { ...request, operationId: 'new-source-operation' }, () => {}), { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.equal(compiles, 0); assert.deepEqual(snapshot(db), before);
});

test('startup and exact legacy conversation recovery preserve held UNKNOWN bytes and never resume work', async t => {
  const db = openData(':memory:');
  const lifecycle = createLifecycle(db), item = db.prepare("SELECT id FROM extensions WHERE owner_id='maya'").get().id;
  const input = { conversationId: 'historical-chat', operationId: 'original-turn', text: 'Original request', expectedVersion: 0,
    expectedDraftVersion: 0, target: { kind: 'resume', extensionId: item } };
  const state = createAuthoringState({ ownerId: 'maya', sessionId: 'old-session', conversationId: input.conversationId, runId: 'old-run' });
  state.status = 'BLOCKED'; state.lastResult = { status: 'BLOCKED', code: 'CHECKPOINT_UNCERTAIN' };
  state.usage.reservedMicros = 1234;
  const encoded = JSON.stringify({ ...state, historicalUnknown: { outcome: 'UNKNOWN', heldMicros: 1234 } });
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(input.conversationId, 'maya', 'original-create', 1, 'old-run', 'RUNNING', 0,
    state.createdAt, encoded, JSON.stringify([{ id: input.operationId, hash: digest(json(input)), runId: 'old-run', version: 1 }]),
    JSON.stringify({ messages: [], code: 'CHECKPOINT_UNCERTAIN', review: null }), state.createdAt);
  db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run(input.conversationId, 'maya', item, 'REVISE', null, 1);
  db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run(input.conversationId, 'maya', input.operationId, digest(json(input)), 'old-run', 1);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run(input.conversationId, 'maya', 'old-run', 1, 'provider', null, 1234, 'UNKNOWN');
  db.prepare('UPDATE authoring_budget SET reserved_micros=1234').run();
  const rows = () => ['authoring_conversations', 'authoring_operations', 'authoring_dispatches', 'authoring_budget'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = rows(), native = taskService(db).listProjects('maya');
  const service = createAuthoringService({ db, lifecycle, providerFactory() { throw new Error('Legacy recovery must not use a provider'); } });
  t.after(async () => { await service.close(); db.close(); });
  assert.deepEqual(rows(), before, 'Startup preserves all legacy bytes, including an interrupted old run.');
  const lease = { sessionId: 'current-session', current: () => true };
  const recovered = await service.turn('maya', input, lease);
  assert.equal(recovered.conversation.retired, true);
  assert.deepEqual(service.recover('maya', input).operation, recovered.operation);
  await assert.rejects(service.turn('maya', { ...input, text: 'changed' }, lease), { status: 409 });
  await assert.rejects(service.turn('maya', { ...input, operationId: 'new-turn', expectedVersion: 1 }, lease), { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.deepEqual(rows(), before);
  assert.deepEqual(taskService(db).listProjects('maya'), native);
});
