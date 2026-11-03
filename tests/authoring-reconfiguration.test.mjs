import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openData, resetData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createAuthoringSettings } from '../src/authoring-settings.mjs';
import { readSetupConfig } from '../src/authoring-config.mjs';

const settingsInput = (apiKey = 'synthetic-key-a', maxUsd = '3') => ({ provider: 'openai', model: 'gpt-5.6-terra', apiKey, maxUsd });
const input = (operationId, fields = {}) => ({ conversationId: null, operationId, text: 'Read-only task advice, please.',
  expectedVersion: 0, expectedDraftVersion: 0, ...fields });
const lease = { sessionId: 'test-session', current: () => true };
const reply = { calls: [], text: 'Ready to continue.', continuation: { opaque: 'native-continuation' }, usage: { inputTokens: 1, outputTokens: 1 } };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const held = db => db.prepare('SELECT reserved_micros n FROM authoring_budget WHERE id=1').get().n;

test('replacement cannot persist while a cancelled provider is settling and never refunds reservations', async t => {
  const db = openData(':memory:'), entered = gate(), release = gate();
  const original = readSetupConfig(settingsInput(), randomUUID());
  const service = createAuthoringService({ db, lifecycle: createLifecycle(db), config: original,
    providerFactory: config => ({ ...config, complete: async () => { entered.resolve(); await release.promise; return reply; } }) });
  t.after(async () => { release.resolve(); await service.close(); db.close(); });
  const started = await service.turn('maya', input('held-provider'), lease);
  await entered.promise;
  const next = readSetupConfig(settingsInput('synthetic-key-b'), randomUUID());
  let writes = 0;
  assert.throws(() => service.configure(next, () => writes++), { code: 'AI_BUSY', status: 409 });
  const { id, version, runId } = started.conversation;
  service.cancel('maya', id, { runId, expectedVersion: version }, lease);
  assert.throws(() => service.configure(next, () => writes++), { code: 'AI_BUSY', status: 409 });
  assert.equal(writes, 0); assert.equal(held(db), original.reserveMicros);
  release.resolve(); await service.wait('maya', id);
  service.configure(next, () => writes++);
  assert.equal(writes, 1); assert.equal(held(db), original.reserveMicros);
  assert.throws(() => service.configure(readSetupConfig(settingsInput('synthetic-key-c', '0.01'), randomUUID()), () => writes++),
    { code: 'SPEND_LIMIT', status: 409 });
  assert.equal(writes, 1); assert.equal(held(db), original.reserveMicros);
  assert.throws(() => service.configure(next, () => { throw Error('synthetic disk failure'); }), /synthetic disk failure/);
  assert.equal(held(db), original.reserveMicros);
});

test('key-only settings revisions survive restart, fence old chains and preserve the shared ledger through reset', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-ai-reconfigure-'));
  const path = join(directory, 'app.sqlite'), file = join(directory, 'ai-authoring.json');
  let db, service, settings, requests = [];
  const open = () => {
    db = openData(path); settings = createAuthoringSettings({ file, env: {} });
    service = createAuthoringService({ db, lifecycle: createLifecycle(db), config: settings.config,
      providerFactory: config => ({ ...config, complete: async () => { requests.push(config.apiKey); return reply; } }) });
  };
  const close = async () => { await service?.close(); service = undefined; db?.close(); db = undefined; };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  open();
  const first = settings.prepare(settingsInput()); service.configure(first.config, first.persist);
  const aInput = input('configuration-a'), a = await service.turn('maya', aInput, lease);
  const aSaved = await service.wait('maya', a.conversation.id), creditA = held(db);
  const second = settings.prepare(settingsInput('synthetic-key-b')); service.configure(second.config, second.persist);
  const revision = settings.config.settingsRevision;
  assert.notEqual(revision, first.config.settingsRevision);
  const resumeA = input('resume-a', { conversationId: aSaved.id, expectedVersion: aSaved.version });
  await assert.rejects(service.turn('maya', resumeA, lease), { code: 'CONFIG_CHANGED', status: 409 });
  assert.equal((await service.turn('maya', aInput, lease)).conversation.id, aSaved.id, 'exact retries read prior operation');
  assert.equal(held(db), creditA);
  const b = await service.turn('leo', input('configuration-b'), lease);
  const bSaved = await service.wait('leo', b.conversation.id), creditB = held(db);
  assert.deepEqual(requests, ['synthetic-key-a', 'synthetic-key-b']);
  for (const row of db.prepare('SELECT state FROM authoring_conversations').all()) {
    assert.equal(row.state.includes('synthetic-key-'), false);
    assert.equal(JSON.parse(row.state).transport.settingsRevision.length, 36);
  }
  await close(); open();
  assert.equal(settings.config.settingsRevision, revision);
  assert.equal(held(db), creditB); assert.equal(requests.length, 2, 'startup never dispatches');
  await assert.rejects(service.turn('maya', resumeA, lease), { code: 'CONFIG_CHANGED' });
  const resumed = await service.turn('leo', input('resume-b', { conversationId: bSaved.id, expectedVersion: bSaved.version }), lease);
  await service.wait('leo', resumed.conversation.id);
  assert.equal(requests.length, 3); const beforeReset = held(db), savedFile = readFileSync(file);
  await close();
  const backup = await resetData(directory, true);
  assert.deepEqual(readFileSync(file), savedFile);
  assert.equal(readFileSync(backup).includes(Buffer.from('synthetic-key-')), false, 'database backup has no credentials');
  open(); assert.equal(held(db), beforeReset); assert.equal(settings.config.settingsRevision, revision);
});
