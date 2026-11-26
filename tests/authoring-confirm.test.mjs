import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { AuthoringError } from '../src/authoring-provider.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';

let program;
before(async () => { program = await compileTaskCustomization(); });

for (const mode of ['cancel', 'fence', 'invalid suite', 'unavailable check', 'restart']) {
  test(`Personal confirmation: ${mode} never retries or grants approval`, async t => {
    const db = openData(':memory:');
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const config = { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 10, maxMicros: 100 };
    let providers = 0, compilerCalls = 0;
    const lifecycle = createLifecycle(db, { compiler: { async compile() {
      compilerCalls++;
      entered.resolve();
      if (['cancel', 'fence'].includes(mode)) await release.promise;
      return { artifact: program.artifactBytes, diagnostics: [] };
    } } });
    const makeService = () => createAuthoringService({ db, lifecycle, config, providerFactory: () => ({
      reserveMicros: 10, maxMicros: 100, async complete(request) {
        providers++;
        assert.equal(request.continuation, undefined);
        assert.ok(request.tools.every(tool => !/resolve_intent|compile_draft|simulate_draft/.test(tool.name)));
        return { calls: [{ id: 'offer', name: 'offer_proposal', arguments: { hookId: 'TaskCompleted',
          sourceJson: program.source, cases: mode === 'invalid suite' ? ['{}'] : program.cases,
          expectedDraftVersion: 0, summary: 'Create one follow-up when a matching task is completed.' } }],
          continuation: { secret: 'opaque-provider-chain' }, text: '', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    }) });
    const service = makeService();
    t.after(async () => { release.resolve(); await service.close(); db.close(); });
    const lease = { sessionId: 'current-session', current: () => true };
    const turn = await service.turn('maya', { conversationId: null, operationId: randomUUID(), expectedVersion: 0,
      expectedDraftVersion: 0, target: { kind: 'create' }, text: 'Prepare the matching follow-up.' }, lease);
    const offered = await service.wait('maya', turn.conversation.id);
    const { id, runId, version, extensionId, offer } = offered;
    assert.equal(offered.status, 'AWAITING_USER');
    assert.equal(compilerCalls, 0);
    const payload = { runId, expectedVersion: version, offerDigest: offer.digest };
    if (mode === 'unavailable check' || mode === 'restart') {
      db.exec("CREATE TEMP TRIGGER fail_personal_check BEFORE INSERT ON extension_evidence BEGIN SELECT RAISE(ABORT,'Synthetic unavailable check'); END");
    }
    service.confirm('maya', id, payload, lease);
    await entered.promise;
    if (mode === 'cancel') service.cancel('maya', id, { runId, expectedVersion: version }, lease);
    if (mode === 'fence') db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskCompleted'").run();
    release.resolve();
    const result = await service.wait('maya', id);
    const saved = mode === 'unavailable check' || mode === 'restart';
    assert.equal(result.confirmation, saved ? 'saved' : 'unsaved');
    assert.equal(result.review, null);
    assert.equal(lifecycle.state('maya', extensionId).draftVersion, saved ? 1 : 0);
    assert.equal(lifecycle.state('maya', extensionId).approved, false);
    assert.equal(lifecycle.state('maya', extensionId).selection.revision, null);
    assert.equal(service.confirm('maya', id, payload, lease).confirmation, result.confirmation);
    if (mode === 'restart') {
      // Represent a process lost after its transaction recorded the exact save.
      db.prepare("UPDATE authoring_conversations SET status='RUNNING' WHERE id=?").run(id);
      const restarted = makeService();
      assert.equal(restarted.read('maya', id).status, 'INTERRUPTED');
      assert.equal(restarted.confirm('maya', id, payload, lease).confirmation, 'saved');
      await restarted.close();
    }
    assert.equal(compilerCalls, 1);
    assert.equal(providers, 1);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT state,view FROM authoring_conversations WHERE id=?').get(id)), /opaque-provider-chain/);
    assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 10);
  });
}

for (const code of ['CONTEXT_LIMIT', 'SPEND_LIMIT', 'CHECKPOINT_UNCERTAIN']) {
  test(`Normal turn: ${code} cannot dispatch or confer confirmation authority`, async t => {
    const db = openData(':memory:'), lifecycle = createLifecycle(db);
    let calls = 0;
    const config = { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 10, maxMicros: code === 'SPEND_LIMIT' ? 9 : 20 };
    const service = createAuthoringService({ db, lifecycle, config, checkpointFault(event) {
      if (code === 'CHECKPOINT_UNCERTAIN' && event.phase === 'RESULT' && event.stage === 'afterCommit') throw new Error('Synthetic checkpoint failure');
    }, providerFactory: () => ({
      reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
      preflight() { if (code === 'CONTEXT_LIMIT') throw new AuthoringError(code); },
      async complete() {
        calls++;
        return { calls: [{ id: 'offer', name: 'offer_proposal', arguments: { hookId: 'TaskCompleted', sourceJson: program.source,
          cases: program.cases, expectedDraftVersion: 0, summary: 'Propose an inert draft.' } }],
          text: '', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    }) });
    t.after(async () => { await service.close(); db.close(); });
    const input = { conversationId: null, operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0,
      target: { kind: 'create' }, text: 'Prepare an example.' };
    const lease = { sessionId: 'test-session', current: () => true };
    const started = await service.turn('maya', input, lease);
    const result = await service.wait('maya', started.conversation.id);
    assert.equal(result.code, code);
    assert.equal(result.offer, null);
    assert.equal(service.recover('maya', input).operation.id, input.operationId);
    assert.equal((await service.turn('maya', input, lease)).conversation.offer, null);
    assert.equal(calls, code === 'CHECKPOINT_UNCERTAIN' ? 1 : 0);
    assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, calls * config.reserveMicros);
    assert.equal(db.prepare('SELECT count(*) AS n FROM extension_revisions').get().n, 0);
  });
}
