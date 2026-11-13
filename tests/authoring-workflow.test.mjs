import test from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { evidenceSummary } from '../src/authoring-example.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { authoringDefinition } from '../src/extension-catalog.mjs';
import { taskCreateGuardFixture } from './fixtures/task-create-guard.mjs';
import { restoreSavedCore030, savedCore030 } from './fixtures/saved-core-0.3.0.mjs';

test('authoring discovers and recompiles an authentic older model without migrating it or borrowing approval', { timeout: 60_000 }, async t => {
  const db = openData(':memory:'); restoreSavedCore030(db);
  const lifecycle = createLifecycle(db, { compiler: createCompiler() });
  const extensionId = 'compat-030-TaskBeforeCreate', before = lifecycle.state('maya', extensionId);
  const oldSource = lifecycle.source('maya', before.draft.id, extensionId);
  const host = authoringDefinition('TaskBeforeCreate', before.draft.pins.modelDigest);
  const fixture = taskCreateGuardFixture({ host, rule: 'priority-note', projectId: savedCore030.projectId });
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
    KEIR_AI_MAX_USD: '2', OPENAI_API_KEY: 'synthetic-key' });
  let discovery;
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: () => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete(request) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!request.toolResult) return { calls: [{ id: 'discover', name: 'discover_catalog', arguments: {} }], text: '', usage };
      const output = JSON.parse(request.toolResult.output); assert.equal(output.ok, true);
      if (!discovery) {
        discovery = output.result;
        return { calls: [{ id: 'compile', name: 'compile_draft', arguments: { hookId: 'TaskBeforeCreate', sourceJson: fixture.source,
          expectedDraftVersion: discovery.currentDraft.draftVersion } }], text: '', usage };
      }
      return { calls: [], text: 'The edited draft needs its own checked examples and approval.', usage };
    },
  }) });
  t.after(async () => { await service.close(); db.close(); });
  const { conversation } = await service.turn('maya', { conversationId: null, operationId: 'retained-model-authoring',
    text: 'Require notes for high-priority new tasks instead.', expectedVersion: 0, expectedDraftVersion: before.draftVersion,
    target: { kind: 'revise', extensionId, baseRevisionId: before.draft.id, selectionGeneration: before.selection.generation } }, { sessionId: 'retained-authoring', current: () => true });
  assert.equal((await service.wait('maya', conversation.id)).status, 'IDLE');
  assert.deepEqual([discovery.dcm.format, discovery.source, discovery.scenario, discovery.compiler],
    ['keir-dcm/3', 'keir/2', 'keir-scenario/4', 'keir-compiler-java/0.5.0']);
  assert.equal(discovery.currentProposal.source, oldSource.source);
  const after = lifecycle.state('maya', extensionId);
  assert.notEqual(after.draft.id, before.draft.id);
  assert.equal(after.draft.pins.modelDigest, before.draft.pins.modelDigest);
  assert.equal(after.draft.pins.compiler, 'keir-compiler-java/0.5.0');
  assert.equal(after.approved, false);
  assert.deepEqual(after.selection, before.selection);
  assert.deepEqual(lifecycle.source('maya', before.draft.id, extensionId), oldSource);
});

test('discovery shows all three trigger contracts without binding a trigger or activating an item', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db);
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
    KEIR_AI_MAX_USD: '1', OPENAI_API_KEY: 'synthetic-key' });
  let discovery, requests = 0;
  const service = createAuthoringService({ db, lifecycle, config, providerFactory: () => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete(request) {
      requests++;
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!request.toolResult) return { calls: [{ id: 'discover', name: 'discover_catalog', arguments: {} }], text: '', usage };
      discovery = JSON.parse(request.toolResult.output).result;
      return { calls: [], text: 'Saved discussion.', usage };
    },
  }) });
  t.after(async () => { await service.close(); db.close(); });
  const lease = { sessionId: 'workflow-test', current: () => true };
  const input = { conversationId: null, operationId: 'workflow-test', text: 'Could I add a due date automatically?',
    expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } };
  const { conversation: admitted } = await service.turn('maya', input, lease);
  const conversation = await service.wait('maya', admitted.id);
  assert.equal(conversation.status, 'IDLE');
  assert.equal(discovery.dcm.format, 'keir-dcm/4');
  assert.deepEqual([discovery.source, discovery.artifact, discovery.scenario], ['keir/3', 'keir-artifact/4', 'keir-scenario/4']);
  assert.equal(discovery.selectedHook, null);
  assert.equal(discovery.currentUse.unavailableReason, 'TRIGGER_UNRESOLVED');
  assert.equal(discovery.hook, undefined);
  for (const hook of ['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate']) {
    assert.ok(discovery.supportedHooks.some(item => item.id === hook));
    const examples = discovery.examplesByHook[hook];
    assert.equal(JSON.parse(examples.sourceExample).entrypoint, hook);
    assert.equal(JSON.parse(examples.scenarioExample).format, 'keir-scenario/4');
  }
  const guard = discovery.examplesByHook.TaskBeforeCreate;
  assert.deepEqual(guard.scenarioExamples.map(text => JSON.parse(text).expect.consumption.status), ['ALLOWED', 'DENIED', 'ALLOWED', 'BLOCKED']);
  for (const text of guard.scenarioExamples) assert.deepEqual(Object.keys(JSON.parse(text).given.input).sort(),
    ['hasDueDate', 'hasNotes', 'priority', 'projectId', 'tags']);
  assert.equal(discovery.dcm.entrypoints.TaskBeforeCreate.consumer.kind, 'DECISION');
  assert.equal(lifecycle.state('maya', conversation.extensionId).extension.hookId, null);
  assert.equal(conversation.draft.revisionId, null);

  const row = db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(conversation.id);
  const stageA = JSON.stringify({ ...JSON.parse(row.state), definitionId: 'daymark.task-completed/3' });
  db.prepare('UPDATE authoring_conversations SET state=? WHERE id=?').run(stageA, conversation.id);
  assert.equal(service.read('maya', conversation.id).retired, true);
  assert.deepEqual(service.read('maya', conversation.id).messages, conversation.messages);
  assert.equal(service.list('maya', conversation.extensionId).current, null);
  assert.ok(service.transcript('maya', conversation.extensionId).messages.some(message => message.text === 'Saved discussion.'));
  await assert.rejects(service.turn('maya', { ...input, conversationId: conversation.id, operationId: 'resume-legacy',
    expectedVersion: conversation.version, target: { kind: 'resume', extensionId: conversation.extensionId } }, lease),
  { status: 410, code: 'LEGACY_CUSTOMIZATION_RETIRED' });
  assert.equal(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(conversation.id).state, stageA);
  assert.equal(requests, 2);
});

test('assistant evidence keeps write types, exact dates and Boolean lookup criteria separate', () => {
  const occurredAt = '2026-03-07T12:34:56.789Z', dueAt = '2026-03-14T12:34:56.789Z';
  const task = { id: 'example', title: 'Quote', priority: 'normal', tags: ['client'] };
  const updatedTasks = [{ id: task.id, dueAt }];
  const criterion = { projectId: 'reviews', title: 'Follow-up', matches: false };
  const summary = evidenceSummary({ reports: [{ id: 'update-example', expected: { createdTasks: [], updatedTasks },
    report: { status: 'PASS', mismatches: [], observed: { effect: 'CONFIRMED', createdTasks: [], updatedTasks },
      scenario: { occurredAt, task, openMatches: [{ ...criterion, id: 'not-evidence' }] } },
  }] }, ['{"id":"update-example"}']);
  const [example] = summary.cases;
  assert.deepEqual(example.actual.observed, { effect: 'CONFIRMED', createdTasks: [], updatedTasks });
  assert.deepEqual(example.expected.updatedTasks, updatedTasks);
  assert.deepEqual(example.scenario, { occurredAt, task, openMatches: [criterion] });
  assert.equal(summary.truncated, false);
});

test('assistant evidence preserves independent decision expectations and the closed proposal without claiming a saved task', () => {
  const allow = { status: 'ALLOWED', result: { decision: 'ALLOW', message: '' } };
  const deny = { status: 'DENIED', result: { decision: 'DENY', message: '<b>Add a due date</b>', private: 'hidden' } };
  const proposal = { projectId: 'project1', priority: 'high', tags: ['client'], hasNotes: false, hasDueDate: false };
  const proof = { reports: [
    { id: 'mismatch', expected: { outcome: { classification: 'COMPLETED' }, consumption: allow }, report: {
      status: 'FAIL', native: { classification: 'COMPLETED', result: deny.result }, consumption: deny,
      scenario: { proposal: { ...proposal, title: 'hidden', notes: 'hidden' } }, mismatches: [{ stage: 'CONSUMPTION', code: 'MISMATCH' }],
    } },
    { id: 'blocked', expected: { outcome: { classification: 'FAILED' }, consumption: { status: 'BLOCKED' } }, report: {
      status: 'PASS', native: { classification: 'BUSINESS_REJECTION', result: allow.result }, consumption: { status: 'BLOCKED' },
      scenario: { proposal }, mismatches: [],
    } },
  ] };
  const summary = evidenceSummary(proof, []), [mismatch, blocked] = summary.cases;
  assert.deepEqual(mismatch.expected.consumption, allow);
  assert.deepEqual(mismatch.actual.consumption, { status: 'DENIED', result: { decision: 'DENY', message: '<b>Add a due date</b>' } });
  assert.deepEqual(mismatch.scenario, { proposal });
  assert.deepEqual(blocked.actual.consumption, { status: 'BLOCKED' });
  assert.deepEqual(blocked.actual.native, { classification: 'BUSINESS_REJECTION' });
  assert.equal(Object.hasOwn(mismatch.actual, 'observed'), false);
  assert.equal(Object.hasOwn(mismatch.expected, 'createdTasks'), false);
  assert.equal(JSON.stringify(summary).includes('hidden'), false);
  assert.equal(summary.truncated, false);
  const clipped = structuredClone(proof);
  clipped.reports[0].report.consumption.result.message = 'x'.repeat(140);
  const bounded = evidenceSummary(clipped, []);
  assert.equal(bounded.cases[0].actual.consumption.result.message.length, 128);
  assert.equal(bounded.truncated, true);
});
