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
test(`${provider} renews before-save proposal context and confirms the saved ${matches ? 'matching' : 'mismatched'} suite`, async t => {
  const db = openData(':memory:'), native = taskService(db);
  const project = native.createProject('maya', { name: 'Packing project' });
  const other = native.createProject('maya', { name: 'Other packing project' });
  const lifecycle = createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  const guard = taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule: 'project-priority', projectId: project.id, otherProjectId: other.id });
  if (!matches) {
    const independent = JSON.parse(guard.cases[0]);
    independent.expect.outcome.result = { decision: 'DENY', message: 'Independent wrong expectation λ😀\nKeep this exact text.' };
    independent.expect.consumption = { status: 'DENIED', result: independent.expect.outcome.result };
    guard.cases[0] = JSON.stringify(independent, null, 2) + '\n';
  }
  const { extensionId } = admitTaskDraft(db, lifecycle), owner = 'maya';
  let prior = await lifecycle.compile(owner, { extensionId, hookId: 'TaskBeforeCreate', source: guard.source, draftVersion: 0 }, () => {});
  prior = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: prior.revisionId, draftVersion: 1, cases: guard.cases }, () => {});
  const source = JSON.parse(guard.source);
  source.name += '-revised';
  const revised = JSON.stringify(source);
  const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const openai = provider === 'openai';
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: openai ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
    KEIR_AI_MAX_USD: '3', OPENAI_API_KEY: 'synthetic-packing-key', ANTHROPIC_API_KEY: 'synthetic-packing-key' });
  let calls = 0, renewed = false;
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: () => {
    const native = createAuthoringProvider(config, { fetchImpl: async (_url, init) => {
      assert.ok(Buffer.byteLength(init.body) <= 131072);
      const body = JSON.parse(init.body), items = openai ? body.input : body.messages;
      assert.equal(items.length, 1, 'Renewal discards the entire native call/result/reasoning chain.');
      const envelope = JSON.parse(openai ? items[0].content : items[0].content[0].text);
      let name = 'discover_catalog', args = {};
      if (calls++) {
        const facts = envelope.renewedContext.currentContext;
        assert.equal(facts.extension.id, extensionId);
        assert.deepEqual(facts.currentProposal.cases, guard.cases);
        assert.equal(facts.currentProposal.revisionId, prior.revisionId);
        args = { hookId: 'TaskBeforeCreate', sourceJson: revised, cases: facts.currentProposal.cases,
          expectedDraftVersion: prior.draftVersion, summary: 'Keep the independent before-save examples.' };
        name = 'offer_proposal';
      }
      return Response.json(openai
        ? { status: 'completed', output: [{ type: 'function_call', call_id: `call-${calls}`, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `call-${calls}`, name, input: args }], usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    return { ...native, preflight(request) {
      if (request.toolResult && !renewed) { renewed = true; throw new AuthoringError('CONTEXT_LIMIT'); }
      return native.preflight(request);
    } };
  } });
  t.after(async () => { await service.close(); db.close(); });
  const lease = { sessionId: 'packing-session', current: () => true };
  const input = { conversationId: null, operationId: 'packing-guard', expectedVersion: 0, expectedDraftVersion: prior.draftVersion,
    target: { kind: 'revise', extensionId, baseRevisionId: prior.revisionId, selectionGeneration: prior.selection.generation },
    text: 'Revise the rule and keep every independent example exactly.' };
  const accepted = await service.turn(owner, input, lease);
  const offered = await service.wait(owner, accepted.conversation.id);
  assert.equal(offered.status, 'AWAITING_USER', JSON.stringify(offered));
  assert.equal(lifecycle.state(owner, extensionId).revisionId, prior.revisionId);
  service.confirm(owner, offered.id, { runId: offered.runId, expectedVersion: offered.version, offerDigest: offered.offer.digest }, lease);
  const result = await service.wait(owner, offered.id);
  assert.equal(result.status, 'REVIEW_AVAILABLE');
  assert.equal(result.review.eligible, matches);
  const saved = lifecycle.state(owner, extensionId);
  assert.equal(saved.draftVersion, prior.draftVersion + 1);
  assert.deepEqual(lifecycle.source(owner, saved.revisionId, extensionId).cases, guard.cases);
  assert.deepEqual(lifecycle.source(owner, prior.revisionId, extensionId).cases, guard.cases);
  assert.equal(lifecycle.source(owner, saved.revisionId, extensionId).source, revised);
  assert.equal(saved.approved, false);
  assert.equal(saved.selection.revision, null);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
  assert.equal(service.recover(owner, input).conversation.review.evidenceId, result.review.evidenceId);
  assert.equal((await service.turn(owner, input, lease)).conversation.review.evidenceId, result.review.evidenceId);
  assert.equal(calls, 2);
  assert.equal(renewed, true);
});
