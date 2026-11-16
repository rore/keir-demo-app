import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { AuthoringError, createAuthoringProvider } from '../src/authoring-provider.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

for (const provider of ['openai', 'anthropic']) for (const matches of [true, false])
test(`${provider} renews real before-save authoring with exact ${matches ? 'matching' : 'mismatched'} cases, intent, receipts and native pairing`, async t => {
  const db = openData(':memory:'), native = taskService(db);
  const project = native.createProject('maya', { name: 'Packing project' });
  const other = native.createProject('maya', { name: 'Other packing project' });
  const lifecycle = createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  const guard = taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule: 'project-priority', projectId: project.id, otherProjectId: other.id });
  if (!matches) {
    const independent = JSON.parse(guard.cases[0]);
    independent.expect.outcome.result = { decision: 'DENY', message: 'Independently expected denial.' };
    independent.expect.consumption = { status: 'DENIED', result: independent.expect.outcome.result };
    guard.cases[0] = JSON.stringify(independent, null, 2);
  }
  const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
    KEIR_AI_MAX_USD: '20', OPENAI_API_KEY: 'synthetic-packing-key', ANTHROPIC_API_KEY: 'synthetic-packing-key' });
  const names = ['resolve_intent', 'discover_catalog', 'compile_draft', 'propose_scenarios', 'discover_catalog', 'discover_catalog', 'simulate_draft', 'offer_review'];
  const requests = [], checkpointSizes = [];
  let renewed = 0;
  const service = createAuthoringService({ db, lifecycle, config, checkpointFault: point => {
    if (point.stage === 'afterCommit') {
      const row = db.prepare('SELECT state,operations,view FROM authoring_conversations LIMIT 1').get();
      checkpointSizes.push(Buffer.byteLength(row.state + row.operations + row.view));
    }
  }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), index = requests.length, name = names[index], id = 'packing-' + index;
    assert.ok(name, 'Renewal must not add a provider round or classify again.');
    const items = provider === 'openai' ? body.input : body.messages;
    const pending = new Set();
    for (const item of items) {
      if (item.type === 'function_call') pending.add(item.call_id);
      if (item.type === 'function_call_output') assert.ok(pending.delete(item.call_id));
      for (const part of item.content ?? []) {
        if (part.type === 'tool_use') pending.add(part.id);
        if (part.type === 'tool_result') assert.ok(pending.delete(part.tool_use_id));
      }
    }
    assert.equal(pending.size, 0);
    const user = provider === 'openai' ? items.findLast(item => item.role === 'user')?.content
      : items.findLast(item => item.role === 'user')?.content.find(item => item.type === 'text')?.text;
    const data = user ? JSON.parse(user) : null;
    const output = provider === 'openai' ? items.filter(item => item.type === 'function_call_output').at(-1)?.output
      : items.at(-1)?.content.find(item => item.type === 'tool_result')?.content;
    if (data?.renewedContext && !output) {
      renewed++;
      assert.equal(items.length, 1, 'A fresh native envelope has no orphan result or partial reasoning block.');
      assert.equal(data.currentUserMessage, input.text);
      assert.equal(data.hostContext.intent, 'prepare');
      assert.equal(data.hostContext.editingTarget.extensionId, data.renewedContext.currentContext.extension.id);
      assert.equal(data.renewedContext.currentContext.currentProposal.source, guard.source);
      assert.deepEqual(data.renewedContext.currentContext.currentProposal.cases, guard.cases);
      assert.deepEqual(data.renewedContext.completedChanges.map(item => item.name), ['compile_draft', 'propose_scenarios']);
      assert.equal(data.renewedContext.lastTool.name, 'discover_catalog');
    }
    const prior = output ? JSON.parse(output).result : data?.renewedContext?.currentContext;
    let args = {};
    if (name === 'resolve_intent') args = { intent: 'prepare', question: '' };
    if (name === 'compile_draft') args = { hookId: 'TaskBeforeCreate', sourceJson: guard.source, expectedDraftVersion: prior.currentDraft.draftVersion };
    if (name === 'propose_scenarios') args = { revisionId: prior.revisionId, expectedDraftVersion: prior.draftVersion, cases: guard.cases };
    if (name === 'simulate_draft') args = { revisionId: prior.currentDraft.revisionId, expectedDraftVersion: prior.currentDraft.draftVersion };
    if (name === 'offer_review') args = { summary: 'The independent before-save examples matched. Your real tasks have not changed.' };
    requests.push({ name, bytes: Buffer.byteLength(init.body) });
    assert.ok(requests.at(-1).bytes <= 131072);
    return Response.json(provider === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: [] },
        { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'opaque-reasoning', signature: 'native-signature' },
        { type: 'tool_use', id, name, input: args }], usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  t.after(async () => { await service.close(); db.close(); });
  const input = { conversationId: null, operationId: 'packing-guard', expectedVersion: 0, expectedDraftVersion: 0,
    target: { kind: 'create' }, intent: 'auto', text: 'Require an explicit priority for tasks in Packing project. Other projects may pass. Keep independent allow, deny, nonmatching and unavailable cases.' };
  const lease = { sessionId: 'packing-session', current: () => true };
  const accepted = await service.turn('maya', input, lease), result = await service.wait('maya', accepted.conversation.id);
  assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.eligible, matches);
  assert.equal(renewed, 1); assert.deepEqual(requests.map(item => item.name), names);
  assert.ok(requests[5].bytes > 100000); assert.ok(requests[6].bytes < requests[5].bytes);
  assert.ok(checkpointSizes.every(bytes => bytes <= 262144));
  const saved = lifecycle.state('maya', result.extensionId), source = lifecycle.source('maya', saved.draft.id, result.extensionId);
  assert.equal(source.source, guard.source); assert.deepEqual(source.cases, guard.cases);
  assert.equal(saved.draftVersion, 2); assert.equal(saved.approved, false); assert.equal(saved.selection.revision, null);
  assert.equal(saved.evidence.id, result.review.evidenceId); assert.equal(saved.evidence.passed, matches);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
  const state = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(result.id).state);
  assert.equal(state.resolvedIntent, 'prepare'); assert.equal(state.counts.compiles, 1); assert.equal(state.counts.simulations, 1);
  assert.equal(state.usage.reservedMicros, names.length * config.reserveMicros);
  const dispatches = db.prepare('SELECT kind,outcome FROM authoring_dispatches WHERE conversation_id=? ORDER BY ordinal').all(result.id);
  assert.equal(dispatches.filter(row => row.kind === 'provider').length, names.length);
  assert.ok(dispatches.every(row => row.outcome === 'SUCCESS'));
  assert.equal(service.recover('maya', input).conversation.id, result.id);
  assert.equal((await service.turn('maya', input, lease)).conversation.id, result.id);
  assert.equal(requests.length, names.length, 'Exact recovery never repeats work or classification.');
  t.diagnostic(JSON.stringify({ requests, largestCheckpointBytes: Math.max(...checkpointSizes), reservedMicros: state.usage.reservedMicros }));
});

for (const provider of ['openai', 'anthropic']) for (const discovery of [true, false])
for (const failure of discovery ? [null, 'missing', 'truncated', 'oversized', 'checkpoint'] : [null])
test(`${provider} preserves prior wrong expectations across two recompiles (${discovery ? 'discovered' : 'no discovery'}, ${failure ?? 'exact restoration'})`, async t => {
  const db = openData(':memory:'), native = taskService(db);
  const project = native.createProject('maya', { name: 'Prior independent cases' });
  const other = native.createProject('maya', { name: 'Other prior project' });
  const lifecycle = createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  const guard = taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule: 'project-priority', projectId: project.id, otherProjectId: other.id });
  const independent = JSON.parse(guard.cases[0]);
  independent.expect.outcome.result = { decision: 'DENY', message: 'Independent wrong expectation λ😀\nKeep this exact text.' };
  independent.expect.consumption = { status: 'DENIED', result: independent.expect.outcome.result };
  guard.cases[0] = JSON.stringify(independent, null, 2) + '\n';
  const { extensionId } = admitTaskDraft(db, lifecycle);
  let saved = await lifecycle.compile('maya', { extensionId, hookId: 'TaskBeforeCreate', source: guard.source, draftVersion: 0 }, () => {});
  saved = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases: guard.cases }, () => {});
  saved = await lifecycle.simulate('maya', { extensionId, revisionId: saved.draft.id, draftVersion: saved.draftVersion }, () => {});
  assert.equal(saved.evidence.passed, false);
  const prior = { revisionId: saved.draft.id, suiteDigest: saved.draft.suiteDigest };
  const readSource = lifecycle.source;
  lifecycle.source = (owner, revisionId, itemId) => {
    const value = readSource(owner, revisionId, itemId);
    if (revisionId !== prior.revisionId || lifecycle.state(owner, itemId).draftVersion < 3) return value;
    if (failure === 'missing') return { ...value, cases: null };
    if (failure === 'truncated') return { ...value, truncated: true };
    if (failure === 'oversized') return { ...value, cases: ['x'.repeat(49153)] };
    return value;
  };
  const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
    KEIR_AI_MAX_USD: '20', OPENAI_API_KEY: 'synthetic-recompile', ANTHROPIC_API_KEY: 'synthetic-recompile' });
  const names = ['resolve_intent', ...(discovery ? ['discover_catalog'] : []), 'compile_draft', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review'];
  const requests = [], forced = new Set(), renewals = [], sizes = [];
  let compilation = 0, revisedSource, restoredCases, faulted = false;
  const service = createAuthoringService({ db, lifecycle, config, checkpointFault: point => {
    if (point.stage === 'beforeCommit' && failure === 'checkpoint' && compilation === 1 && point.phase === 'RESULT' && point.ordinal === 5) {
      faulted = true; throw Error('Lost compile result checkpoint');
    }
    if (point.stage === 'afterCommit') {
      const row = db.prepare('SELECT state,operations,view FROM authoring_conversations WHERE creation_operation_id=?').get('recompile-renewal');
      sizes.push(Buffer.byteLength(row.state + row.operations + row.view));
    }
  }, providerFactory: () => {
    const adapter = createAuthoringProvider(config, { fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), index = requests.length, name = names[index], id = 'recompile-' + index;
      assert.ok(name, 'No extra provider round, reclassification or replay.');
      const items = provider === 'openai' ? body.input : body.messages, pending = new Set();
      for (const item of items) {
        if (item.type === 'function_call') pending.add(item.call_id);
        if (item.type === 'function_call_output') assert.ok(pending.delete(item.call_id));
        for (const part of Array.isArray(item.content) ? item.content : []) {
          if (part.type === 'tool_use') pending.add(part.id);
          if (part.type === 'tool_result') assert.ok(pending.delete(part.tool_use_id));
        }
      }
      assert.equal(pending.size, 0);
      const user = provider === 'openai' ? items.findLast(item => item.role === 'user')?.content
        : items.findLast(item => item.role === 'user')?.content.find(item => item.type === 'text')?.text;
      const data = user ? JSON.parse(user) : null;
      const output = provider === 'openai' ? items.findLast(item => item.type === 'function_call_output')?.output
        : items.at(-1)?.content.find(item => item.type === 'tool_result')?.content;
      const renewed = data?.renewedContext;
      if (renewed && !output) {
        assert.equal(items.length, 1, 'Renewal drops complete native chains including opaque reasoning.');
        assert.equal(data.hostContext.intent, 'prepare');
        assert.equal(data.currentUserMessage, input.text);
        assert.equal(renewed.currentContext.extension.id, extensionId);
        assert.equal(renewed.currentContext.currentProposal.source, revisedSource);
        assert.deepEqual(renewed.currentContext.currentProposal.cases, []);
        assert.equal(renewed.currentContext.currentProposal.suiteDigest, null);
        assert.deepEqual(renewed.currentContext.priorScenarios, { extensionId, ...prior, cases: guard.cases });
        restoredCases = renewed.currentContext.priorScenarios.cases;
        renewals.push({ afterCompilation: compilation, priorRevisionId: prior.revisionId, bytes: Buffer.byteLength(init.body) });
      }
      const result = output ? JSON.parse(output).result : renewed?.currentContext.currentDraft;
      let args = {};
      if (name === 'resolve_intent') args = { intent: 'prepare', question: '' };
      if (name === 'compile_draft') {
        compilation++;
        const source = JSON.parse(guard.source); source.name += '-revision-' + compilation;
        revisedSource = JSON.stringify(source, null, 2);
        args = { hookId: 'TaskBeforeCreate', sourceJson: revisedSource, expectedDraftVersion: saved.draftVersion + compilation - 1 };
      }
      if (name === 'propose_scenarios') args = { revisionId: result.revisionId, expectedDraftVersion: result.draftVersion, cases: restoredCases };
      if (name === 'simulate_draft') args = { revisionId: result.revisionId, expectedDraftVersion: result.draftVersion };
      if (name === 'offer_review') args = { summary: 'The unchanged independent expectation did not match. Your real tasks have not changed.' };
      requests.push({ name, bytes: Buffer.byteLength(init.body) });
      assert.ok(requests.at(-1).bytes <= 131072);
      return Response.json(provider === 'openai'
        ? { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque-prior-reasoning', summary: [] },
          { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'opaque-prior-reasoning', signature: 'native-signature' },
          { type: 'tool_use', id, name, input: args }], usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    return { ...adapter, preflight(request) {
      // Force the precise interval under review without raising or lowering native wire guards.
      if (request.toolResult && compilation > forced.size) { forced.add(compilation); throw new AuthoringError('CONTEXT_LIMIT'); }
      return adapter.preflight(request);
    } };
  } });
  t.after(async () => { await service.close(); db.close(); });
  const input = { conversationId: null, operationId: 'recompile-renewal', expectedVersion: 0, expectedDraftVersion: saved.draftVersion,
    target: { kind: 'revise', extensionId, baseRevisionId: prior.revisionId, selectionGeneration: saved.selection.generation },
    intent: 'auto', text: 'Revise the source name twice. Keep every saved independent example and its exact expected outcome, then check them.' };
  const lease = { sessionId: 'recompile-session', current: () => true };
  const accepted = await service.turn('maya', input, lease), result = await service.wait('maya', accepted.conversation.id);
  const current = lifecycle.state('maya', extensionId);
  const state = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(result.id).state);
  if (failure) {
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.code, failure === 'checkpoint' ? 'CHECKPOINT_UNCERTAIN' : 'CONTEXT_LIMIT');
    assert.equal(current.draftVersion, 3); assert.equal(current.draft.suiteDigest, null);
    assert.equal(renewals.length, 0);
    assert.equal(requests.length, 3);
    assert.deepEqual(state.scenarioSource, prior, 'Prior revision is durable before compilation, including a lost result checkpoint.');
    if (failure === 'checkpoint') assert.equal(faulted, true);
  } else {
    assert.equal(result.status, 'REVIEW_AVAILABLE'); assert.equal(result.review.eligible, false);
    assert.equal(current.evidence.passed, false);
    const proof = lifecycle.evidence('maya', current.evidence.id, extensionId);
    assert.equal(proof.reports[0].expected.outcome.result.decision, 'DENY');
    assert.equal(proof.reports[0].report.native.result.decision, 'ALLOW');
    assert.equal(current.draftVersion, 5);
    assert.equal(readSource('maya', current.draft.id, extensionId).source, revisedSource);
    assert.deepEqual(readSource('maya', current.draft.id, extensionId).cases, guard.cases);
    assert.deepEqual(renewals.map(row => row.afterCompilation), [1, 2]);
    assert.equal(state.counts.compiles, 2); assert.equal(state.counts.simulations, 1);
    assert.equal(state.scenarioSource.revisionId, current.draft.id);
    assert.deepEqual(requests.map(row => row.name), names);
  }
  assert.deepEqual(readSource('maya', prior.revisionId, extensionId).cases, guard.cases);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
  assert.equal(current.approved, false); assert.equal(current.selection.revision, null);
  assert.equal(state.resolvedIntent, 'prepare');
  assert.equal(state.usage.reservedMicros, requests.length * config.reserveMicros);
  assert.ok(sizes.every(bytes => bytes <= 262144));
  const dispatches = db.prepare('SELECT kind,outcome FROM authoring_dispatches WHERE conversation_id=? ORDER BY ordinal').all(result.id);
  assert.equal(dispatches.filter(row => row.kind === 'provider').length, requests.length);
  assert.ok(dispatches.every(row => row.outcome === 'SUCCESS' || failure === 'checkpoint' && row.kind === 'tool' && row.outcome === 'UNKNOWN'));
  assert.equal(service.recover('maya', input).conversation.id, result.id);
  assert.equal((await service.turn('maya', input, lease)).conversation.id, result.id);
  assert.equal(requests.length, failure ? 3 : names.length, 'Exact recovery never repeats compilation or classification.');
  if (failure === 'checkpoint') {
    await service.close();
    const restarted = createAuthoringService({ db, lifecycle, config, providerFactory: () => { assert.fail('Restart must not replay work.'); } });
    try {
      assert.equal(restarted.read('maya', result.id).status, 'BLOCKED');
      assert.deepEqual(JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(result.id).state).scenarioSource, prior);
      assert.equal(requests.length, 3);
    } finally { await restarted.close(); }
  }
  t.diagnostic(JSON.stringify({ renewals, requests, largestCheckpointBytes: Math.max(...sizes), reservedMicros: state.usage.reservedMicros }));
});
