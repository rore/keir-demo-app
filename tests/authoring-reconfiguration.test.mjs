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
const input = (operationId, fields = {}) => ({ target: { kind: 'create' }, conversationId: null, operationId, text: 'Read-only task advice, please.',
  expectedVersion: 0, expectedDraftVersion: 0, ...fields });
const lease = { sessionId: 'test-session', current: () => true };
const reply = { calls: [], text: 'Ready to continue.', continuation: { opaque: 'native-continuation' }, usage: { inputTokens: 1, outputTokens: 1 } };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const held = db => db.prepare('SELECT reserved_micros n FROM authoring_budget WHERE id=1').get().n;

test('old OpenAI reservations retain a conservative surcharge across restart, owner and configuration changes', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db);
  let service, calls = 0;
  const create = config => createAuthoringService({ db, lifecycle, config,
    providerFactory: value => ({ ...value, complete: async () => { calls++; return reply; } }) });
  t.after(async () => { await service?.close(); db.close(); });
  service = create({ ...readSetupConfig(settingsInput()), reserveMicros: 319488 });
  const first = await service.turn('maya', input('old-reservation'), lease);
  await service.wait('maya', first.conversation.id); await service.close();
  const receipt = db.prepare('SELECT * FROM authoring_dispatches').all();
  assert.equal(held(db), 319488);
  service = create(readSetupConfig(settingsInput('synthetic-key', '0.706560')));
  let persisted = 0;
  assert.throws(() => service.configure(readSetupConfig(settingsInput('synthetic-key', '0.387071')), () => persisted++), { code: 'SPEND_LIMIT' });
  assert.equal(persisted, 0);
  const rejected = await service.turn('leo', input('old-hold-blocks-owner'), lease);
  assert.equal((await service.wait('leo', rejected.conversation.id)).code, 'SPEND_LIMIT');
  assert.equal(calls, 1, 'raw old hold plus new reservation is insufficient once its missing surcharge is retained');
  assert.deepEqual(db.prepare('SELECT * FROM authoring_dispatches').all(), receipt, 'historical receipts are not rewritten');
  service.configure(readSetupConfig(settingsInput('synthetic-key', '0.774144')), () => {});
  const exact = await service.turn('leo', input('exact-corrected-allowance'), lease);
  assert.equal((await service.wait('leo', exact.conversation.id)).status, 'IDLE');
  assert.equal(calls, 2); assert.equal(held(db), 319488 + 387072, 'raw reservations stay immutable and do not compound the surcharge');
  const stopped = await service.turn('sam', input('no-third-owner-credit'), lease);
  assert.equal((await service.wait('sam', stopped.conversation.id)).code, 'SPEND_LIMIT');
  assert.equal(calls, 2);
});

test('reset keeps unjournaled old allowance charged, and startup/configuration never dispatches or rewrites it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-legacy-allowance-')), path = join(directory, 'app.sqlite');
  let db = openData(path), service, calls = 0;
  const create = config => createAuthoringService({ db, lifecycle: createLifecycle(db), config,
    providerFactory: value => ({ ...value, complete: async () => { calls++; return reply; } }) });
  t.after(async () => { await service?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); });
  service = create({ ...readSetupConfig(settingsInput()), reserveMicros: 319488 });
  const first = await service.turn('maya', input('legacy-before-reset'), lease);
  await service.wait('maya', first.conversation.id); await service.close(); db.close();
  await resetData(directory, true); db = openData(path);
  assert.equal(held(db), 319488); assert.equal(db.prepare('SELECT COUNT(*) n FROM authoring_dispatches').get().n, 0);
  service = create(readSetupConfig(settingsInput('synthetic-key', '0.706560')));
  assert.equal(calls, 1); assert.equal(held(db), 319488);
  const blocked = await service.turn('maya', input('after-reset-blocked'), lease);
  assert.equal((await service.wait('maya', blocked.conversation.id)).code, 'SPEND_LIMIT'); assert.equal(calls, 1);
  service.configure(readSetupConfig(settingsInput('synthetic-key', '0.774144')), () => {});
  const exact = await service.turn('maya', input('after-reset-exact'), lease);
  assert.equal((await service.wait('maya', exact.conversation.id)).status, 'IDLE');
  assert.equal(calls, 2); assert.equal(held(db), 706560);
});

test('unattributed allowance rounding and overflow fail closed before any provider dispatch', async t => {
  for (const raw of [1, Number.MAX_SAFE_INTEGER]) {
    const db = openData(':memory:'); let calls = 0;
    db.prepare('UPDATE authoring_budget SET reserved_micros=?').run(raw);
    const service = createAuthoringService({ db, lifecycle: createLifecycle(db),
      config: readSetupConfig(settingsInput('synthetic-key', raw === 1 ? '0.387073' : '')),
      providerFactory: value => ({ ...value, complete: async () => { calls++; return reply; } }) });
    t.after(async () => { await service.close(); db.close(); });
    if (raw === 1) {
      const accepted = await service.turn('maya', input('rounded-unknown-credit'), lease);
      assert.equal((await service.wait('maya', accepted.conversation.id)).code, 'SPEND_LIMIT');
    } else await assert.rejects(service.turn('maya', input('overflow-credit'), lease), { code: 'CHECKPOINT_UNCERTAIN' });
    assert.equal(calls, 0); assert.equal(held(db), raw);
  }
});

test('known other-provider and corrected OpenAI receipts are not given the legacy surcharge', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db); let service, calls = 0;
  const create = config => createAuthoringService({ db, lifecycle, config,
    providerFactory: value => ({ ...value, complete: async () => { calls++; return reply; } }) });
  t.after(async () => { await service?.close(); db.close(); });
  service = create(readSetupConfig({ ...settingsInput(), provider: 'anthropic', model: 'claude-haiku-5-5' }));
  const first = await service.turn('maya', input('known-other-provider'), lease);
  await service.wait('maya', first.conversation.id); await service.close();
  assert.equal(held(db), 77824);
  service = create(readSetupConfig(settingsInput('synthetic-key', '0.464896')));
  const exact = await service.turn('leo', input('corrected-exact-fit'), lease);
  assert.equal((await service.wait('leo', exact.conversation.id)).status, 'IDLE');
  assert.equal(held(db), 77824 + 387072); assert.equal(calls, 2);
  service.configure(readSetupConfig(settingsInput('synthetic-key', '0.464896')), () => {});
  db.prepare('UPDATE authoring_budget SET reserved_micros=reserved_micros-1').run();
  await assert.rejects(service.turn('maya', input('inconsistent-held-total'), lease), { code: 'CHECKPOINT_UNCERTAIN' });
  assert.equal(calls, 2);
});

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

test('disabling the allowance survives restart, fences old chains and preserves reservations through reset', async t => {
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
  const second = settings.prepare(settingsInput('synthetic-key-b', '')); service.configure(second.config, second.persist);
  assert.equal(settings.publicConfiguration().maxUsd, null);
  const revision = settings.config.settingsRevision;
  assert.notEqual(revision, first.config.settingsRevision);
  const resumeA = input('resume-a', { target: { kind: 'resume', extensionId: aSaved.extensionId }, conversationId: aSaved.id, expectedVersion: aSaved.version });
  await assert.rejects(service.turn('maya', resumeA, lease), { code: 'CONFIG_CHANGED', status: 409 });
  assert.equal((await service.turn('maya', aInput, lease)).conversation.id, aSaved.id, 'exact retries read prior operation');
  assert.equal(held(db), creditA);
  const b = await service.turn('leo', input('configuration-b'), lease);
  const bSaved = await service.wait('leo', b.conversation.id), creditB = held(db);
  assert.equal(creditB, creditA + second.config.reserveMicros);
  const tooLow = settings.prepare(settingsInput('synthetic-key-b', '0.5'));
  assert.throws(() => service.configure(tooLow.config, tooLow.persist), { code: 'SPEND_LIMIT', status: 409 });
  assert.deepEqual(requests, ['synthetic-key-a', 'synthetic-key-b']);
  for (const row of db.prepare('SELECT state FROM authoring_conversations').all()) {
    assert.equal(row.state.includes('synthetic-key-'), false);
    assert.equal(JSON.parse(row.state).transport.settingsRevision.length, 36);
  }
  await close(); open();
  assert.equal(settings.config.settingsRevision, revision);
  assert.equal(settings.publicConfiguration().maxUsd, null);
  assert.equal(held(db), creditB); assert.equal(requests.length, 2, 'startup never dispatches');
  await assert.rejects(service.turn('maya', resumeA, lease), { code: 'CONFIG_CHANGED' });
  const resumed = await service.turn('leo', input('resume-b', { target: { kind: 'resume', extensionId: bSaved.extensionId }, conversationId: bSaved.id, expectedVersion: bSaved.version }), lease);
  await service.wait('leo', resumed.conversation.id);
  assert.equal(requests.length, 3); const beforeReset = held(db), savedFile = readFileSync(file);
  await close();
  const backup = await resetData(directory, true);
  assert.deepEqual(readFileSync(file), savedFile);
  assert.equal(readFileSync(backup).includes(Buffer.from('synthetic-key-')), false, 'database backup has no credentials');
  open(); assert.equal(held(db), beforeReset); assert.equal(settings.config.settingsRevision, revision);
});
