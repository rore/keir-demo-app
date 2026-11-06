import test from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { evidenceSummary } from '../src/authoring-example.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';

test('discovery shows both trigger contracts without binding a trigger or activating an item', async t => {
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
  assert.equal(discovery.dcm.format, 'keir-dcm/2');
  assert.equal(discovery.selectedHook, null);
  assert.equal(discovery.currentUse.unavailableReason, 'TRIGGER_UNRESOLVED');
  assert.equal(discovery.hook, undefined);
  for (const hook of ['TaskCreated', 'TaskCompleted']) {
    assert.ok(discovery.supportedHooks.some(item => item.id === hook));
    const examples = discovery.examplesByHook[hook];
    assert.equal(JSON.parse(examples.sourceExample).entrypoint, hook);
    assert.equal(JSON.parse(examples.scenarioExample).format, 'keir-scenario/2');
  }
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
