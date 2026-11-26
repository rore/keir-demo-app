import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { openData } from '../src/data.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';

// Synthetic live-gate offer, reserialized without any session or provider data.
const hookId = 'TaskCompleted';
const host = loadHost(hookId), model = JSON.parse(host.dcmBytes);
const cel = text => ({ cel: text });
const candidate = {
  language: 'keir/3', domain: { ...model.domain, fingerprint: host.pins.modelDigest }, entrypoint: hookId, name: 'follow-up-for-customer-tag',
  steps: [
    { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
    { id: 'eligible', let: cel('source.status == "COMPLETED" && source.tags.exists(tag, tag == "for customer")') },
    { id: 'followUpTitle', let: cel('source.title + " follow up"') },
    { id: 'created', call: 'tasks.create', when: 'eligible', args: {
      projectId: cel('source.projectId'), title: cel('followUpTitle'), dueAt: cel('input.occurredAt + duration("604800s")'),
    } },
  ],
  return: { record: { status: cel('eligible ? "CREATED" : "NO_OP"') } },
};
const first = { projectId: 'project-a', title: 'Call Alex', occurredAt: '2026-03-07T12:34:56.789Z', dueAt: '2026-03-14T12:34:56.789Z', priority: 'normal' };
const second = { projectId: 'project-b', title: 'Email Sam!', occurredAt: '2026-11-01T01:30:00.000Z', dueAt: '2026-11-08T01:30:00.000Z', priority: 'high' };
function example(id, taskId, sample, { created, plural, noRead, reject, fixed } = {}) {
  const { projectId, title, occurredAt, dueAt, priority } = sample;
  const call = (step, capability, args) => ({ step, capability, version: model.capabilities[capability].version, args, protectedArgs: { actorId: 'user1' } });
  const read = call('source', 'tasks.get', { taskId }), write = call('created', 'tasks.create', { projectId, title: title + ' follow up', dueAt });
  const at = ({ step, capability }) => ({ step, capability });
  const trace = [], add = (event, fields) => trace.push({ sequence: trace.length, event, ...fields });
  add('INVOCATION_START');
  add('STEP_START', { step: read.step });
  add('CALL_DISPATCHED', at(read));
  const stubs = [{ ...read, response: noRead ? { kind: 'TRANSIENT_FAILURE' } : { kind: 'SUCCESS',
    value: { id: taskId, projectId, title, status: 'COMPLETED', tags: plural ? ['for customers'] : priority === 'high' ? ['review', 'for customer'] : ['for customer'], priority } } }];
  const calls = [read], effects = [];
  const code = noRead ? 'ADAPTER_TRANSIENT' : reject ? 'TASK_INVALID' : null;
  if (!noRead) {
    add('CALL_SUCCEEDED', at(read));
    for (const step of ['eligible', 'followUpTitle']) { add('STEP_START', { step }); add('VALUE_BOUND', { step }); }
    add('STEP_START', { step: write.step });
    add('GUARD_EVALUATED', { step: write.step, taken: !plural });
    if (plural) add('STEP_SKIPPED', { step: write.step });
    else {
      add('EFFECT_INTENT', at(write));
      add('CALL_DISPATCHED', at(write));
      calls.push(write);
      const state = reject ? 'NONE' : 'CONFIRMED';
      stubs.push({ ...write, response: reject ? { kind: 'BUSINESS_REJECTION', code, ...(fixed && { effect: state }) }
        : { kind: 'SUCCESS', value: { id: created }, effect: state } });
      if (!reject || fixed) {
        effects.push({ ...at(write), state });
        add('EFFECT_RECORDED', effects[0]);
      }
      if (!reject) add('CALL_SUCCEEDED', at(write));
    }
  }
  if (!code) add('RETURNED');
  add('TERMINATED', code ? { code } : {});
  const expected = { classification: noRead ? 'FAILED' : reject ? 'BUSINESS_REJECTION' : 'COMPLETED',
    ...(code ? { error: { code, path: noRead ? '/steps/0' : '/steps/3' } } : { result: { status: plural ? 'NO_OP' : 'CREATED' } }), effects };
  return JSON.stringify({ format: 'keir-scenario/4', id, given: { fixture: 'normal', input: { taskId, occurredAt } }, stubs,
    expect: { outcome: { ...expected, trace }, calls, consumption: { status: 'REPORTED', ...expected } } });
}
const unchanged = [
  example('matching-customer-tag-project-a', 'task-a', first, { created: 'follow-a' }),
  example('matching-customer-tag-project-b', 'task-b', second, { created: 'follow-b' }),
  example('plural-tag-does-not-match', 'task-plural', first, { plural: true }),
  example('source-read-unavailable', 'task-unavailable', first, { noRead: true }),
];
const cases = [...unchanged, example('creation-rejected', 'task-write-failure', first, { reject: true })];
const corrected = [...unchanged, example('creation-rejected', 'task-write-failure', first, { reject: true, fixed: true })];

test('Personal live-gate inputs explain both Confirm failures and preserve all five cases in a freshly confirmed correction', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler: createCompiler() });
  const config = { status: 'ready', provider: 'openai', model: 'offline', maxMicros: 100, reserveMicros: 1 };
  const originalSource = JSON.stringify(candidate);
  const updated = structuredClone(candidate);
  updated.steps[1].let = cel('source.status == "COMPLETED" && "for customer" in source.tags');
  const fixedSource = JSON.stringify(updated);
  const summary = 'For the exact tag “for customer”, append “ follow up” in the same project, due 168 hours after completion.';
  let calls = 0;
  const startService = () => createAuthoringService({ db, lifecycle, config, providerFactory: () => ({
    reserveMicros: 1, maxMicros: 100, async complete(request) {
      calls++;
      const usage = { inputTokens: 1, outputTokens: 1 };
      const call = (name, args) => ({ calls: [{ id: name, name, arguments: args }], text: '', usage });
      if (!request.toolResult) return call('discover_catalog', {});
      const { result: catalog } = JSON.parse(request.toolResult.output);
      assert.match(catalog.businessContext.scope, /scope, not a project name/);
      assert.match(catalog.businessContext.expressions, /"<tag>" in source\.tags/);
      assert.match(catalog.businessContext.rejectedWrite, /EFFECT_RECORDED.*state:"NONE"/);
      const rejected = catalog.rejectedOffer;
      if (!rejected) return call('offer_proposal', { hookId, expectedDraftVersion: 0, summary, sourceJson: originalSource, cases });
      assert.deepEqual(rejected.cases, cases);
      if (calls === 4 || calls === 6) {
        assert.equal(rejected.source, originalSource);
        assert.deepEqual(rejected.diagnostics, [{ code: 'DATAFLOW_UNAVAILABLE', path: '/source/steps/1/let/cel' }]);
        if (calls === 4) return { calls: [], text: 'The proposal could not be prepared. The exact tag and title are supported, and nothing was saved.', usage };
        return call('offer_proposal', { hookId, expectedDraftVersion: 0, summary, sourceJson: fixedSource, cases });
      }
      assert.equal(rejected.source, fixedSource);
      assert.deepEqual(rejected.diagnostics, [{ code: 'INVALID_SCENARIO', path: '/cases/4' }]);
      return call('offer_proposal', { hookId, expectedDraftVersion: 0, summary, sourceJson: fixedSource, cases: corrected });
    },
  }) });
  let service = startService();
  t.after(async () => { await service.close(); db.close(); });
  const lease = { sessionId: 'offline-live-confirm', current: () => true };
  let conversation;
  async function send(text) {
    const accepted = await service.turn('maya', { conversationId: conversation?.id ?? null, operationId: `send-${calls}`,
      expectedVersion: conversation?.version ?? 0, expectedDraftVersion: 0,
      target: conversation ? { kind: 'resume', extensionId: conversation.extensionId } : { kind: 'create' }, text }, lease);
    conversation = await service.wait('maya', accepted.conversation.id);
  }
  async function confirm() {
    const { id, runId, version, offer } = conversation, before = calls;
    assert.equal(conversation.status, 'AWAITING_USER');
    const input = { runId, expectedVersion: version, offerDigest: offer.digest };
    service.confirm('maya', id, input, lease);
    conversation = await service.wait('maya', id);
    assert.deepEqual(service.confirm('maya', id, input, lease), conversation);
    assert.equal(calls, before, 'Confirm and exact readback never contact the provider.');
  }
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  await send('Use tag “for customer”, same Personal project, title plus “ follow up”, and exactly 168 elapsed hours.');
  assert.equal(count('extension_revisions'), 0);
  await confirm();
  assert.equal(conversation.confirmation, 'unsaved');
  assert.match(conversation.messages.at(-1).text, /No draft was saved/);
  assert.doesNotMatch(JSON.stringify(conversation), /DATAFLOW_UNAVAILABLE|sourceJson/);
  await service.close();
  service = startService();
  await send('What do you mean?');
  assert.equal(conversation.offer, null);
  assert.match(conversation.messages.at(-1).text, /exact tag and title are supported/);
  await send('Correct the proposal without changing its behavior.');
  await confirm();
  assert.equal(conversation.confirmation, 'unsaved');
  assert.equal(count('extension_revisions'), 0);
  assert.equal(count('extension_evidence'), 0);
  await send('Please correct the rejected example without dropping it.');
  assert.equal(count('extension_revisions'), 0);
  await confirm();
  assert.equal(conversation.confirmation, 'passed', JSON.stringify(conversation));
  const { extensionId, review } = conversation;
  const { reports } = lifecycle.evidence('maya', review.evidenceId, extensionId);
  assert.deepEqual(reports.map(row => row.report.status), Array(5).fill('PASS'));
  assert.deepEqual(reports.map(row => row.report.observed.createdTasks.map(({ projectId, title, dueAt }) => ({ projectId, title, dueAt }))), [
    ...[first, second].map(({ projectId, title, dueAt }) => [{ projectId, title: title + ' follow up', dueAt }]), [], [], [],
  ]);
  assert.deepEqual(reports[4].report.native.effects, [{ step: 'created', capability: 'tasks.create', state: 'NONE' }]);
  assert.deepEqual(lifecycle.source('maya', review.revisionId, extensionId).cases, corrected);
  assert.equal(count('extension_revisions'), 1);
  assert.equal(count('extension_approvals'), 0);
  assert.equal(lifecycle.state('maya', extensionId).selection.revision, null);
});
