import { test as base, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

// Presentation projections only: mocked evidence does not qualify a compiled rule or native enforcement.
const test = base.extend({ demo: async ({}, use) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-create-studio-'));
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = await start({ directory, port });
  try { await use(server); } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
} });
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const review = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
const composer = page => studio(page).getByLabel('Message to Daymark assistant', { exact: true });
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');

async function fixture(page, demo, { mismatch = false, corruptPass = false } = {}) {
  await page.goto(demo.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible();
  const owner = { id: 'maya', name: 'Maya' }, projectId = demo.db.prepare("SELECT id FROM projects WHERE owner_id='maya'").get().id;
  const source = JSON.stringify({ language: 'keir/2', entrypoint: 'TaskBeforeCreate', steps: [{ id: 'condition', let: { cel: 'arbitraryExpressionThatMustNotBecomeASummary' } }] });
  const artifact = JSON.stringify({ format: 'keir-artifact/3', entrypoint: 'TaskBeforeCreate', steps: [], sourceDigest: 'synthetic-projection' });
  const pins = { modelRef: { format: 'keir-dcm/3' }, artifactDigest: digest(artifact), rawSourceDigest: digest(source) };
  const revision = id => ({ id, templateId: 'authored', kind: 'authored', suiteDigest: 'suite-' + id, label: 'Unverified label is not rule behavior', pins, provenance: 'customer', extensionId: 'new-task-check', extensionName: 'Client task check' });
  const active = { ...revision('guard-active'), extensionId: 'earlier-check', extensionName: 'Earlier client check' }, draft = revision('guard-draft'), historical = revision('guard-history');
  const selection = { generation: 7, revision: active, eligible: true, approvedEvidenceId: 'proof-active' };
  const eventSelections = {
    TaskCreated: { generation: 11, revision: { id: 'added-rule', extensionId: 'after-added', extensionName: 'Added action' }, eligible: true, approvedEvidenceId: 'added-proof' },
    TaskCompleted: { generation: 13, revision: { id: 'completed-rule', extensionId: 'after-completed', extensionName: 'Completed action' }, eligible: true, approvedEvidenceId: 'completed-proof' },
  };
  let state = { owner, extension: { id: 'new-task-check', name: 'Client task check', hookId: 'TaskBeforeCreate' }, retired: false,
    catalog: [], draftVersion: 2, draft, evidence: { id: 'proof-draft', revisionId: draft.id, passed: !mismatch }, approved: false, approvedEvidenceId: null,
    selection, history: [], restoreTargets: [], evidenceHistory: [{ id: 'proof-history', revisionId: historical.id }], historyNext: null };
  const allowed = { status: 'ALLOWED', result: { decision: 'ALLOW', message: '' } };
  const denied = { status: 'DENIED', result: { decision: 'DENY', message: '<strong>Add a due date</strong> for this client task.' } };
  const blocked = { status: 'BLOCKED' };
  const cases = [
    ['Client task with a due date', { tags: ['client'], hasDueDate: true }, allowed],
    ['Client task without a due date', { tags: ['client'], hasDueDate: false }, denied],
    ['Task without the client tag', { tags: ['review'], hasDueDate: false }, allowed],
    ['The required check is unavailable', { tags: ['client'], hasDueDate: true }, blocked],
  ];
  const proof = (id, revisionId) => ({ id, revisionId, kind: 'authored', identity: {}, passed: !mismatch,
    reports: cases.map(([label, changes, expected], index) => ({ id: 'sample-' + index, label,
      expected: { consumption: expected }, report: {
        status: mismatch && index === 0 ? 'MISMATCH' : 'PASS',
        scenario: { hookId: 'TaskBeforeCreate', proposal: { projectId, priority: 'normal', tags: [], hasNotes: false, hasDueDate: false, ...changes } },
        consumption: index === 0 && mismatch ? blocked : index === 0 && corruptPass ? denied : expected,
        observed: { effect: 'NONE', createdTasks: [], updatedTasks: [] },
        native: { classification: expected.status === 'BLOCKED' ? 'FAILED' : 'COMPLETED', effects: [] },
        mismatches: mismatch && index === 0 ? [{ stage: 'CONSUMPTION', code: 'UNEXPECTED_DECISION' }] : [],
      } })),
  });
  const proofs = { 'proof-draft': proof('proof-draft', draft.id), 'proof-active': proof('proof-active', active.id), 'proof-history': proof('proof-history', historical.id) };
  const conversation = { id: 'guard-discussion', extensionId: state.extension.id, purpose: 'REVISE', version: 1, status: 'REVIEW_AVAILABLE', runId: 'saved-run',
    operation: { id: 'saved-operation', runId: 'saved-run', version: 1 }, draft: { revisionId: draft.id, draftVersion: 2, suiteDigest: draft.suiteDigest },
    selection: { revisionId: active.id, generation: 7 }, code: null,
    review: { revisionId: draft.id, draftVersion: 2, suiteDigest: draft.suiteDigest, evidenceId: 'proof-draft', eligible: !mismatch },
    messages: [
      { id: 'earlier-proof', role: 'assistant', kind: 'review', text: 'Earlier saved examples are available to read.', receipt: { revisionId: historical.id, draftVersion: 1, suiteDigest: historical.suiteDigest, evidenceId: 'proof-history' } },
      ...Array.from({ length: 12 }, (_, index) => ({ id: 'discussion-' + index, role: index % 2 ? 'assistant' : 'user', kind: 'text', text: `Saved discussion ${index + 1}. We are checking a proposed task using sample data. Approval and turning on remain separate choices.` })),
      { id: 'current-proof', role: 'assistant', kind: 'review', text: 'Check these sample decisions before choosing whether to approve.', receipt: { revisionId: draft.id, draftVersion: 2, suiteDigest: draft.suiteDigest, evidenceId: 'proof-draft' } },
    ],
  };
  const mutations = [];
  let approvalGate;
  await page.route('**/api/extensions**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === '/api/extensions/catalog') body = { hooks: ['TaskBeforeCreate', 'TaskCreated', 'TaskCompleted'].map(id => ({ id, label: id, description: 'Supported task rule', effect: '', trigger: '' })),
      model: { dcm: JSON.stringify({ capabilities: { 'tasks.get': {}, 'tasks.create': {}, 'tasks.update': {}, 'tasks.openMatch': {} }, types: { Task: { fields: {} } } }), digest: 'synthetic-catalog', hook: 'TaskCompleted', consumer: {}, compiler: {} } };
    else if (path === '/api/extensions') body = { owner, items: [state, ...Object.entries(eventSelections).map(([hookId, selected]) => ({ extension: { id: selected.revision.extensionId, name: selected.revision.extensionName, hookId }, draftVersion: 0, draft: null, approved: true }))],
      selection: state.selection, selections: { ...eventSelections, TaskBeforeCreate: state.selection }, catalog: [], next: null };
    else if (path.includes('/evidence/')) body = proofs[path.split('/').at(-1)];
    else if (path.includes('/revisions/')) {
      const id = path.split('/').at(-1), saved = [active, draft, historical].find(item => item.id === id);
      body = { extensionId: state.extension.id, revisionId: id, source, artifact, pins, cases: ['independent saved example'], suiteDigest: saved?.suiteDigest };
    } else if (path.endsWith('/approve')) {
      mutations.push({ path, body: route.request().postDataJSON() });
      if (approvalGate) { approvalGate.entered.resolve(); await approvalGate.release.promise; }
      state = { ...state, approved: true, approvedEvidenceId: 'proof-draft' }; body = state;
    } else if (path.endsWith('/activate')) {
      mutations.push({ path, body: route.request().postDataJSON() });
      state = { ...state, selection: { generation: 8, revision: draft, eligible: true, approvedEvidenceId: 'proof-draft' } }; body = state;
    } else if (path === '/api/extensions/new-task-check') body = state;
    if (!body) return route.fulfill({ status: 404, json: { message: 'Mock projection unavailable.' } });
    await route.fulfill({ json: body });
  });
  await page.route('**/api/authoring**', route => route.fulfill({ json: { availability: { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null },
    conversations: [{ id: conversation.id, extensionId: state.extension.id, purpose: 'REVISE', version: 1, status: conversation.status, runId: conversation.runId, operationId: conversation.operation.id }], current: conversation, next: null } }));
  const mobile = (await page.viewportSize()).width < 761;
  if (mobile) await page.getByLabel('Destination', { exact: true }).selectOption('customizations');
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await expect(page.getByText('Checks before adding', { exact: true })).toBeVisible();
  await expect(page.getByText('Actions after adding', { exact: true })).toBeVisible();
  await expect(page.getByText('Actions after completing', { exact: true })).toBeVisible();
  await page.locator('#edit-new-task-check').click();
  await expect(composer(page)).toBeVisible();
  return { mutations, eventSelections, holdApproval() { approvalGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; return approvalGate; } };
}

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, narrow: { width: 320, height: 740 }, short: { width: 683, height: 384 } })) {
  test(`before-create review separates rule decisions, expected unavailability and activation on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    const mock = await fixture(page, demo);
    const behavior = studio(page).getByRole('article', { name: 'About this rule', exact: true });
    await expect(behavior).toContainText('Before a new task is saved.');
    await expect(behavior).toContainText('Your rules for tasks added or completed run afterward.');
    await expect(behavior).toContainText('The saved conditions can’t be summarized here.');
    await expect(behavior).not.toContainText('arbitraryExpressionThatMustNotBecomeASummary');
    await composer(page).fill('Keep this unsent correction.');
    await studio(page).locator('#studio-view-saved').click();
    await expect(review(page).getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
    await expect(review(page)).toContainText('Sample tasks only · no tasks are saved');
    const examples = review(page).getByRole('article', { name: /^Example:/ });
    await expect(examples).toHaveCount(4);
    await expect(examples.nth(0)).toContainText('Allowed by this rule');
    await expect(examples.nth(0)).toContainText('normal permission, validation and save checks');
    await expect(examples.nth(1)).toContainText('<strong>Add a due date</strong>');
    await expect(examples.nth(1).locator('a,strong,input')).toHaveCount(0);
    await expect(examples.nth(3)).toContainText('Could not check');
    await expect(examples.nth(3)).toContainText('Handled as expected');
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await expect(studio(page).locator('.rs-setup-notice')).toBeVisible();
    await expect(composer(page)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await examples.nth(1).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: test.info().outputPath('before-create-review.png') });
    await review(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
    const activate = review(page).getByRole('button', { name: 'Turn on for new tasks', exact: true });
    await expect(activate).toBeEnabled();
    await expect(activate).toBeFocused();
    await expect(review(page)).toContainText('This replaces “Earlier client check” for this trigger.');
    await expect(review(page)).toContainText('Actions after adding or completing keep their current selections.');
    expect(mock.mutations.map(item => item.path)).toEqual(['/api/extensions/new-task-check/approve']);
    await activate.click();
    await expect(review(page).locator('.rs-review-status')).toHaveText('On for new tasks');
    await expect(composer(page)).toHaveValue('Keep this unsent correction.');
    expect(mock.mutations[1].body).toEqual({ revisionId: 'guard-draft', draftVersion: 2, generation: 7, evidenceId: 'proof-draft' });
    expect(mock.eventSelections.TaskCreated.generation).toBe(11);
    expect(mock.eventSelections.TaskCompleted.generation).toBe(13);
  });
}

test('a PASS label cannot qualify mismatching independent before-create expectations', async ({ page, demo }) => {
  await fixture(page, demo, { corruptPass: true });
  await studio(page).locator('#studio-view-saved').click();
  await expect(review(page)).toContainText('Needs another check');
  await expect(review(page)).toContainText('Approval is unavailable.');
  await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
});

test('historical before-create evidence stays exact and read-only', async ({ page, demo }) => {
  const mock = await fixture(page, demo);
  await studio(page).locator('[data-evidence-link="proof-history"]').click();
  const history = studio(page).getByRole('article', { name: 'Sample results', exact: true });
  await expect(history).toContainText('Earlier example · this does not approve your current changes.');
  await history.getByText('Details', { exact: true }).click();
  await expect(history.getByLabel('Saved synthetic simulation report', { exact: true })).toContainText('guard-history');
  await expect(history.getByLabel('Saved synthetic simulation report', { exact: true })).toContainText('proof-history');
  await expect(studio(page).getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
  expect(mock.mutations).toEqual([]);
});

test('unexpected unavailability stays inspectable without an approval action', async ({ page, demo }) => {
  const mock = await fixture(page, demo, { mismatch: true });
  await studio(page).getByRole('button', { name: 'View simulation', exact: true }).click();
  const example = review(page).getByRole('article', { name: 'Example: Client task with a due date', exact: true });
  await expect(example).toContainText('Could not check');
  await expect(example).toContainText('Needs another check');
  await expect(example).toContainText('Allowed by this rule');
  await expect(studio(page).getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
  expect(mock.mutations).toEqual([]);
});

test('a delayed approval preserves short-screen reading, unread reply and composer draft', async ({ page, demo }) => {
  await page.setViewportSize({ width: 683, height: 384 });
  const mock = await fixture(page, demo);
  await composer(page).fill('Keep this unsent correction.');
  await studio(page).locator('#studio-view-saved').click();
  const held = mock.holdApproval();
  await review(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  await held.entered.promise;
  const log = studio(page).getByRole('log', { name: 'Studio conversation', exact: true });
  try {
    await log.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await composer(page).fill('Keep the newer unsent correction.');
  } finally { held.release.resolve(); }
  await expect(studio(page).getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
  expect(await log.evaluate(node => node.scrollTop)).toBe(0);
  await expect(composer(page)).toHaveValue('Keep the newer unsent correction.');
  await expect(composer(page)).toBeFocused();
  await expect(studio(page).locator('.rs-setup-notice')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('before-create-unread-short.png') });
  expect((await log.boundingBox()).height).toBeGreaterThanOrEqual(112);
  await studio(page).getByRole('button', { name: 'New messages ↓', exact: true }).click();
  await expect(composer(page)).toHaveValue('Keep the newer unsent correction.');
});
