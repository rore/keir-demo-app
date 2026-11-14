import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../src/extension-catalog.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { taskCustomizationFixture, compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const activeFixture = taskCustomizationFixture({ title: 'Active customer task' }), draftFixture = taskCustomizationFixture({ title: 'Different customer task' });
let activeArtifact, draftArtifact;
before(async () => {
  activeArtifact = (await compileTaskCustomization({ title: activeFixture.metadata.title })).artifactBytes;
  draftArtifact = (await compileTaskCustomization({ title: draftFixture.metadata.title })).artifactBytes;
});

const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra',
  KEIR_AI_MAX_USD: '5', OPENAI_API_KEY: 'synthetic-test-key' });
const lease = { sessionId: 'current-use-test', current: () => true };
const cases = activeFixture.cases;
const proof = () => ({ id: 'approved-proof', revisionId: 'selected-v1', passed: true,
  reports: cases.map(text => {
    const example = JSON.parse(text), expected = example.expect.outcome;
    const createdTasks = example.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title }));
    return { id: example.id, label: example.id,
      expected: { classification: expected.classification, createdTasks, updatedTasks: [] },
      report: { status: 'PASS', native: expected, consumption: example.expect.consumption, mismatches: [],
        scenario: { task: { id: example.given.input.taskId, status: 'COMPLETED', projectId: 'project1' } },
        observed: { effect: createdTasks.length ? 'CONFIRMED' : 'NONE', createdTasks, updatedTasks: [] } },
      taskRecords: ['private-report-extra'], continuation: 'private-report-extra' };
  }), artifact: 'private-proof-extra' });

function fixture(t) {
  const db = openData(':memory:');
  const compiler = { compile: async bytes => ({ artifact: bytes.toString() === activeFixture.source ? activeArtifact : draftArtifact, diagnostics: [] }) };
  const lifecycle = createLifecycle(db, { compiler });
  const extensionId = admitTaskDraft(db, lifecycle).extensionId;
  t.after(() => db.close());
  return { db, lifecycle, extensionId };
}
async function discover(t, f, options = {}) {
  const reads = [], requests = [];
  const lifecycle = { ...f.lifecycle,
    state(owner, id) {
      const state = f.lifecycle.state(owner, id);
      if (options.selection) {
        state.selection = options.selection(id);
        state.extension = { ...state.extension, hookId: TASK_HOOK };
      }
      return state;
    },
    evidence(...args) { reads.push(['evidence', ...args]); return options.evidence ? options.evidence(...args) : f.lifecycle.evidence(...args); },
    source(...args) { reads.push(['source', ...args]); return options.source ? options.source(...args) : f.lifecycle.source(...args); },
  };
  const service = createAuthoringService({ db: f.db, lifecycle, config, providerFactory: () => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    async complete(request) {
      requests.push(request);
      return { calls: requests.length === 1 ? [{ id: 'discover-current-use', name: 'discover_catalog', arguments: {} }] : [],
        text: 'Checked the available host context.', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }) });
  t.after(() => service.close());
  const state = lifecycle.state('maya', f.extensionId);
  const admitted = await service.turn('maya', { conversationId: null, operationId: 'current-use-discovery',
    expectedVersion: 0, expectedDraftVersion: state.draftVersion, text: 'What is currently in use, and how does my draft differ?',
    target: { kind: 'revise', extensionId: f.extensionId, baseRevisionId: state.revisionId, selectionGeneration: state.selection.generation } }, lease);
  const settled = await service.wait('maya', admitted.conversation.id);
  assert.equal(settled.status, 'IDLE', JSON.stringify(settled));
  assert.equal(requests.length, 2);
  const context = JSON.parse(requests[1].toolResult.output).result;
  assert.ok(Buffer.byteLength(JSON.stringify(context.currentUse)) <= 16384);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  await service.close();
  return { context, reads, requests };
}
const selected = (id, changes = {}) => ({ generation: 7, eligible: true, approvedEvidenceId: 'approved-proof',
  revision: { id: 'selected-v1', extensionId: id, extensionName: 'Known active identity', provenance: 'customer', pins: 'private-selection-extra' }, ...changes });
const selectedSource = id => ({ extensionId: id, revisionId: 'selected-v1', cases,
  source: 'private-selected-source', artifact: 'private-selected-artifact', pins: 'private-selected-pins', hostCases: ['private-host-case'] });

test('discovery separates exact checked active v1 from a different customer task draft v2 without changing selection or proof', async t => {
  const f = fixture(t), { lifecycle, extensionId } = f, authorize = () => {};
  const input = state => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
  async function checked(source, template) {
    let state = lifecycle.state('maya', extensionId);
    state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, draftVersion: state.draftVersion, source }, authorize);
    state = await lifecycle.proposeScenarios('maya', { ...input(state), cases: template.cases }, authorize);
    state = await lifecycle.simulate('maya', input(state), authorize);
    return state;
  }
  let active = await checked(activeFixture.source, activeFixture);
  active = lifecycle.approve('maya', { ...input(active), evidenceId: active.evidence.id }, authorize);
  active = lifecycle.activate('maya', { ...input(active), generation: active.selection.generation, evidenceId: active.approvedEvidenceId }, authorize);
  const draft = await checked(draftFixture.source, draftFixture);
  const activeProof = lifecycle.evidence('maya', active.approvedEvidenceId, extensionId);
  const draftProof = lifecycle.evidence('maya', draft.evidence.id, extensionId);
  const { context, reads, requests } = await discover(t, f);
  assert.equal(context.currentProposal.revisionId, draft.draft.id);
  assert.equal(context.currentUse.relation, 'thisitem');
  assert.deepEqual(context.currentUse.selected, { extensionId, name: active.extension.name, revisionId: active.draft.id,
    provenance: 'customer', eligible: true, approvedEvidenceId: active.approvedEvidenceId });
  assert.equal(context.currentUse.checkedSummary.evidenceId, active.approvedEvidenceId);
  assert.match(context.currentUse.checkedSummary.scope, /synthetic.*not live/);
  assert.equal(context.currentUse.unavailableReason, null);
  assert.equal(context.currentUse.checkedSummary.cases[0].actual.observed.createdTasks[0].title, activeFixture.metadata.title);
  assert.equal(draftProof.reports[0].report.observed.createdTasks[0].title, draftFixture.metadata.title);
  assert.deepEqual(reads, [['source', 'maya', draft.draft.id, extensionId], ['source', 'maya', draft.draft.id, extensionId],
    ['evidence', 'maya', active.approvedEvidenceId, extensionId], ['source', 'maya', active.draft.id, extensionId]]);
  assert.deepEqual(lifecycle.state('maya', extensionId).selection, draft.selection);
  assert.deepEqual(lifecycle.evidence('maya', active.approvedEvidenceId, extensionId), activeProof);
  for (const phrase of ['currentUse.checkedSummary', 'businessContext.navigation as the authoritative source']) assert.ok(requests[0].instructions.includes(phrase));
  assert.match(context.businessContext.navigation, /Never invent Compare versions, View history or a version comparison view/);
  assert.match(context.businessContext.navigation, /On shows.*outside earlier-discussion or stale views/);
  assert.match(context.businessContext.navigation, /View earlier examples opens the exact earlier saved check/);
  assert.match(context.businessContext.navigation, /View checked examples opens a current check that is not eligible for approval/);
  assert.match(context.businessContext.navigation, /Inspect saved source and examples.*not a comparison screen/);
  assert.match(context.businessContext.checking, /example tasks.*your tasks have not changed/);
  assert.match(requests[0].instructions, /After an example check, describe what would happen in that example and say “Your real tasks have not changed”/);
  for (const label of ['Draft', 'Review', 'On', 'Rename',
      'Hide simulation', 'Return to proposal', 'Back to conversation',
      'Approve this change', 'Turn on for tasks added', 'Turn on for tasks completed']) assert.ok(context.businessContext.navigation.includes(label));
  assert.match(context.businessContext.navigation, /do not open or replace.*automatically|never open or replace.*automatically/);
  for (const guidance of [context.businessContext.navigation, requests[0].instructions]) {
    assert.doesNotMatch(guidance, /beside Current decision|Show the unfinished task example/);
    assert.match(guidance, /read-only navigation|without creating or restoring changes/);
    assert.match(guidance, /uncertain outcomes explicit/);
    assert.match(guidance, /chat.*(?:neither approval nor activation|grants neither approval nor activation)/i);
  }
});

test('an explicitly approved customer task version retains its exact checked synthetic summary', async t => {
  const f = fixture(t), { lifecycle, extensionId } = f, authorize = () => {};
  let state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, source: activeFixture.source, draftVersion: 0 }, authorize);
  state = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: state.revisionId, draftVersion: state.draftVersion, cases }, authorize);
  const identity = () => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await lifecycle.simulate('maya', identity(), authorize);
  state = lifecycle.approve('maya', { ...identity(), evidenceId: state.evidence.id }, authorize);
  state = lifecycle.activate('maya', { ...identity(), generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, authorize);
  const { context } = await discover(t, f);
  assert.equal(context.currentUse.selected.provenance, 'customer');
  assert.equal(context.currentUse.checkedSummary.evidenceId, state.approvedEvidenceId);
  assert.equal(context.currentUse.checkedSummary.cases.length, cases.length);
  assert.equal(context.currentUse.unavailableReason, null);
});

for (const [name, change, reason] of [
  ['no selection', value => ({ ...value, revision: null, eligible: false, approvedEvidenceId: null }), 'NO_SELECTION'],
  ['another item', value => ({ ...value, revision: { ...value.revision, extensionId: 'other-owner-item' } }), 'ANOTHER_ITEM_SELECTED'],
  ['ineligible', value => ({ ...value, eligible: false }), 'SELECTION_INELIGIBLE'],
  ['operator', value => ({ ...value, revision: { ...value.revision, provenance: 'operator' } }), 'NO_CUSTOMER_APPROVAL'],
  ['legacy provenance', value => ({ ...value, revision: { ...value.revision, provenance: null } }), 'NO_CUSTOMER_APPROVAL'],
  ['missing approval', value => ({ ...value, approvedEvidenceId: null }), 'APPROVAL_UNAVAILABLE'],
]) test(`current-use ${name} retains known identity without reading selected source or proof`, async t => {
  const f = fixture(t), selection = change(selected(f.extensionId));
  const { context, reads } = await discover(t, f, { selection: () => selection });
  assert.equal(context.currentUse.unavailableReason, reason);
  assert.equal(context.currentUse.checkedSummary, null);
  assert.deepEqual(reads, []);
  if (selection.revision) {
    assert.equal(context.currentUse.selected.revisionId, selection.revision.id);
    assert.equal(context.currentUse.selected.name, selection.revision.extensionName);
    assert.equal(context.currentUse.selected.eligible, selection.eligible);
  } else assert.equal(context.currentUse.selected, null);
});

for (const [name, transform, reason] of [
  ['missing proof', () => { throw new Error('private proof lookup failure'); }, 'APPROVED_PROOF_UNAVAILABLE'],
  ['wrong proof ID', row => ({ ...row, id: 'draft-proof' }), 'APPROVED_PROOF_MISMATCH'],
  ['draft proof', row => ({ ...row, revisionId: 'draft-v2' }), 'APPROVED_PROOF_MISMATCH'],
  ['failed proof', row => ({ ...row, passed: false }), 'APPROVED_PROOF_UNUSABLE'],
  ['empty reports', row => ({ ...row, reports: [] }), 'APPROVED_PROOF_UNUSABLE'],
  ['unusable reports', row => ({ ...row, reports: [{ id: 'bad', expected: {}, report: {} }] }), 'APPROVED_PROOF_UNUSABLE'],
]) test(`current-use ${name} never borrows a checked summary`, async t => {
  const f = fixture(t);
  const { context, reads } = await discover(t, f, { selection: id => selected(id), evidence: () => transform(proof()), source: () => assert.fail('Unusable proof must not read source') });
  assert.equal(context.currentUse.selected.revisionId, 'selected-v1');
  assert.equal(context.currentUse.selected.approvedEvidenceId, 'approved-proof');
  assert.equal(context.currentUse.checkedSummary, null);
  assert.equal(context.currentUse.unavailableReason, reason);
  assert.deepEqual(reads, [['evidence', 'maya', 'approved-proof', f.extensionId]]);
});

test('a host-declared unavailable summary never rebuilds checked active behavior from raw reports', async t => {
  const f = fixture(t);
  const { context } = await discover(t, f, { selection: id => selected(id), evidence: () => ({ ...proof(), summary: null }),
    source: (_owner, _revision, id) => selectedSource(id) });
  assert.equal(context.currentUse.selected.revisionId, 'selected-v1');
  assert.equal(context.currentUse.selected.approvedEvidenceId, 'approved-proof');
  assert.equal(context.currentUse.checkedSummary, null);
  assert.equal(context.currentUse.unavailableReason, 'APPROVED_PROOF_UNAVAILABLE');
});

for (const [name, source, reason] of [
  ['wrong revision', id => ({ ...selectedSource(id), revisionId: 'draft-v2' }), 'APPROVED_SOURCE_MISMATCH'],
  ['wrong item', () => selectedSource('another-item'), 'APPROVED_SOURCE_MISMATCH'],
  ['empty cases', id => ({ ...selectedSource(id), cases: [] }), 'APPROVED_SOURCE_MISMATCH'],
  ['malformed cases', id => ({ ...selectedSource(id), cases: ['{'] }), 'APPROVED_PROOF_UNAVAILABLE'],
]) test(`current-use ${name} cases leave checked behavior explicitly unavailable`, async t => {
  const f = fixture(t);
  const { context } = await discover(t, f, { selection: id => selected(id), evidence: proof, source: (_owner, _revision, id) => source(id) });
  assert.equal(context.currentUse.checkedSummary, null);
  assert.equal(context.currentUse.unavailableReason, reason);
  assert.equal(context.currentUse.selected.name, 'Known active identity');
});

test('current-use projection bounds reports and text, omits oversized summaries and excludes inspection/private fields', async t => {
  for (const oversized of [false, true]) await t.test(oversized ? 'overall byte cap' : 'report and text caps', async t => {
    const f = fixture(t), row = proof(), long = (oversized ? '😀' : 'x').repeat(200);
    row.reports = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(row.reports[0]), id: 'long-' + index,
      label: long, taskStatus: long, readFailure: long, expected: { classification: long, code: long },
      report: { status: 'PASS', native: { classification: long, code: long }, consumption: { status: long, code: long },
        observed: { effect: 'NONE', createdTasks: [], updatedTasks: [] }, mismatches: [] } }));
    const originals = row.reports.map(report => JSON.stringify({ id: report.id, expect: { consumption: { status: long, code: long } } }));
    const { context } = await discover(t, f, { selection: id => selected(id), evidence: () => row,
      source: (_owner, _revision, id) => ({ ...selectedSource(id), cases: originals }) });
    const value = context.currentUse;
    assert.equal(JSON.stringify(value).includes('private-'), false);
    assert.deepEqual(Object.keys(value.selected).sort(), ['approvedEvidenceId', 'eligible', 'extensionId', 'name', 'provenance', 'revisionId']);
    if (oversized) {
      assert.equal(value.checkedSummary, null);
      assert.equal(value.unavailableReason, 'CHECKED_SUMMARY_TOO_LARGE');
    } else {
      assert.equal(value.checkedSummary.cases.length, 8); assert.equal(value.checkedSummary.truncated, true);
      for (const example of value.checkedSummary.cases) for (const text of [example.label, example.taskStatus, example.readFailure, example.expected.code, example.actual.consumption.code]) assert.equal(Array.from(text).length, 128);
    }
  });
});

test('oversized legacy display metadata has an explicit omission without losing selected revision identity', async t => {
  const f = fixture(t), selection = selected(f.extensionId);
  selection.revision.extensionName = 'legacy\0' + 'x'.repeat(20000);
  const { context } = await discover(t, f, { selection: () => ({ ...selection, eligible: false }) });
  assert.equal(context.currentUse.selected.name, null);
  assert.equal(context.currentUse.nameOmittedReason, 'SELECTION_METADATA_TOO_LARGE');
  assert.equal(context.currentUse.selected.revisionId, selection.revision.id);
  assert.equal(context.currentUse.unavailableReason, 'SELECTION_INELIGIBLE');
});
