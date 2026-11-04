import { test as base, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';
import { createApp } from '../../src/app.mjs';
import { openData } from '../../src/data.mjs';
import { loadCatalog } from '../../src/extension-catalog.mjs';
import { spawn } from 'node:child_process';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-lifecycle-browser-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let server;
    try {
      server = await start({ directory, port });
      await use({ origin: server.origin, restart: async () => { await server.close(); server = await start({ directory, port }); },
        invalidateSelectedAdvice: () => server.db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='ClassifyTask')").run() });
    } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
async function openDetails(page) {
  await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
}
async function tasks(page) {
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const destination = page.getByLabel('Destination', { exact: true });
  if (await destination.isVisible()) await destination.selectOption('tasks');
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await tasks(page);
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
}
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function open(page) {
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page).getByRole('button', { name: 'History and details', exact: true })).toBeEnabled();
  expect(await studio(page).locator('.rs-composer').evaluate(form => form.getBoundingClientRect().height)).toBeLessThan(180);
  expect(await studio(page).locator('.rs-header').evaluate(header => header.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
}
const decision = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
const approval = page => decision(page).getByRole('button', { name: 'Approve this change', exact: true });
async function closeDetails(page) {
  const close = studio(page).getByRole('button', { name: 'Back to conversation', exact: true });
  if (await close.isVisible()) await close.click();
}
async function latestExamples(page) {
  await openDetails(page);
  const summary = studio(page).getByText('Saved sample runs', { exact: true });
  if (!await summary.locator('..').evaluate(node => node.open)) await summary.click();
  await studio(page).getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
  await expect(studio(page).getByRole('heading', { name: 'What an unfinished task would show', exact: true })).toBeVisible();
}
async function checkSaved(page) {
  const saved = await savedLifecycle(page, page.url());
  const checked = await lifecyclePost(page, 'simulate', { revisionId: saved.revisionId, draftVersion: saved.draftVersion });
  await reloadStudio(page);
  if (checked.evidence.passed || checked.approved) await openSavedChanges(page);
  return checked;
}
async function prepare(page, label = 'Needs attention') {
  const saved = await savedLifecycle(page, page.url());
  await lifecyclePost(page, 'draft', { templateId: label === 'Pending' ? 'pending' : 'attention', draftVersion: saved.draftVersion });
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  await expect(approval(page)).toBeEnabled();
  await expect(decision(page).locator('.rs-example:visible')).toHaveCount(1);
  await latestExamples(page);
  await expect(studio(page).locator('.rs-example:visible')).toHaveCount(1);
  await expect(studio(page).locator('.rs-example:visible').getByText('Matches what you wanted', { exact: true })).toHaveCount(1);
  const otherExamples = studio(page).getByText('Other checked examples', { exact: true });
  if (!await otherExamples.locator('..').evaluate(node => node.open)) await otherExamples.click();
  const alternatives = studio(page).getByRole('button', { name: /^What (a completed task would show|happens with)/ });
  await expect(alternatives).toHaveCount(5);
  for (const label of await alternatives.allTextContents()) {
    await studio(page).getByRole('button', { name: label, exact: true }).click();
    await expect(studio(page).locator('.rs-example:visible').getByText('Matches what you wanted', { exact: true })).toHaveCount(1);
  }
  await closeDetails(page);
  await openSavedChanges(page);
}
async function approve(page) {
  await openSavedChanges(page);
  await expect(approval(page)).toBeEnabled();
  expect((await savedLifecycle(page, page.url())).approved).toBe(false);
  await expect(studio(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await approval(page).click();
  await expect(studio(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
}
async function inspectActive(page, label) {
  await closeDetails(page);
  const view = studio(page).getByRole('button', { name: 'View what’s in use', exact: true });
  if (await view.isVisible()) {
    await view.click();
    const active = studio(page).getByRole('article', { name: 'Version in use' });
    await active.getByText('Saved version details', { exact: true }).click();
    await expect(active.getByText('Label: ' + label, { exact: true })).toBeVisible();
    expect((await savedLifecycle(page, page.url())).selection.revision.label).toBe(label);
  } else {
    await expect(studio(page).getByLabel('Customization status', { exact: true })).toContainText('In use');
    expect((await savedLifecycle(page, page.url())).selection.revision.label).toBe(label);
  }
}
async function expectOff(page) {
  expect((await savedLifecycle(page, page.url())).selection.revision).toBe(null);
  await closeDetails(page);
  await expect(studio(page).getByRole('log', { name: 'Studio conversation' }).getByText('Your advice is off. Your tasks have not changed.', { exact: true })).toBeVisible();
}
async function picture(page, name) {
  mkdirSync(resolve('build/screens'), { recursive: true });
  await studio(page).evaluate(node => {
    node.querySelector('.rs-canvas').scrollTop = 0;
  });
  if (page.viewportSize().width > 760) {
    expect(await studio(page).locator('.rs-composer').evaluate(form => form.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  }
  await page.screenshot({ path: resolve('build/screens', `${name}.png`), fullPage: true });
}

test('real sample review separates typed assent, approval and use; native edits and other people survive', async ({ page, demo }) => {
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Unsaved lifecycle title');
  await open(page);
  await expect(studio(page).getByLabel('Customization status', { exact: true })).toContainText('In use');
  expect((await savedLifecycle(page, demo.origin)).selection.revision.label).toBe('Pending');
  await prepare(page);
  const ui = studio(page);
  await ui.getByLabel('Message to Studio').fill('Yes, use this advice');
  await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(decision(page)).toContainText('In these example tasks, unfinished tasks showed Needs attention; completed tasks showed Done. Your tasks have not changed.');
  expect((await savedLifecycle(page, demo.origin)).owner.id).toBe('maya');
  await expect(approval(page)).toBeEnabled();
  expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await openDetails(page);
  await inspectActive(page, 'Pending');
  await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await openSavedChanges(page);
  await expect(decision(page)).toBeVisible();
  await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  await openDetails(page);
  await inspectActive(page, 'Pending');
  await closeDetails(page);
  await openSavedChanges(page);
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await openDetails(page);
  await inspectActive(page, 'Needs attention');
  await picture(page, 'read-lifecycle-desktop');
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage task advice', exact: true })).toBeFocused();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
  await open(page);
  await openDetails(page);
  await ui.getByText('Manage saved customization', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expectOff(page);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toHaveCount(0);
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
});

test('lost activation response is read back before retry; historical evidence cannot approve a new draft', async ({ page, demo }) => {
  await enter(page, demo.origin); await open(page); await prepare(page); await approve(page);
  const ui = studio(page); let requests = 0;
  await page.route('**/api/extensions/*/activate', async route => { requests++; await route.fetch(); await route.abort('failed'); });
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await expect(ui.getByRole('status').filter({ hasText: 'Saved state reloaded' })).toBeVisible();
  await inspectActive(page, 'Needs attention'); expect(requests).toBe(1);
  await page.unroute('**/api/extensions/*/activate');
  const selected = await savedLifecycle(page, demo.origin);
  await lifecyclePost(page, 'draft', { templateId: 'pending', draftVersion: selected.draftVersion });
  await reloadStudio(page); await latestExamples(page);
  await ui.locator('.rs-example-details > summary').click();
  await expect(ui.getByText(/Saved sample run · Earlier proposal/)).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
  await latestExamples(page); await expect(approval(page)).toHaveCount(0);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await page.reload(); await expect(ui).toBeVisible(); await latestExamples(page);
  await ui.locator('.rs-example-details > summary').click();
  await expect(ui.getByText(/Saved sample run · Earlier proposal/)).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
});

test('a real already-produced advice response cannot return after a Studio selection transition', async ({ page, demo }) => {
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Keep this edit');
  let release, entered, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/*/advice', async route => {
    const response = await route.fetch(); entered();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }); delivered();
  });
  try {
    await page.getByRole('button', { name: 'Check task advice', exact: true }).click(); await started;
    await open(page);
    await openDetails(page);
    await studio(page).getByText('Manage saved customization', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Turn off my advice', exact: true }).click();
    await expectOff(page);
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    release(); await finished;
    await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Task advice: Pending' })).toHaveCount(0);
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this edit');
  } finally { release?.(); }
});

test('narrow Studio reviews a named operator restore and keeps it after server restart', async ({ page, demo }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, demo.origin);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByLabel('Destination', { exact: true }).selectOption('customizations');
  const saved = await savedLifecycle(page, demo.origin);
  await page.getByRole('article', { name: saved.extension.name, exact: true }).getByRole('button', { name: /^(Open|Continue changes)$/ }).click();
  const ui = studio(page); await openDetails(page);
  await ui.getByText('Manage saved customization', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expectOff(page); await openDetails(page);
  const option = ui.getByLabel('Previously in use').locator('option').filter({ hasText: 'Pending · operator starting choice' });
  await ui.getByLabel('Previously in use').selectOption(await option.getAttribute('value'));
  await expect(ui.getByText('This was an operator-provided starting choice.', { exact: false })).toBeVisible();
  expect((await savedLifecycle(page, demo.origin)).selection.revision).toBe(null);
  await ui.getByRole('button', { name: 'Restore Pending for me', exact: true }).click();
  await inspectActive(page, 'Pending'); await picture(page, 'read-lifecycle-narrow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await demo.restart(); await enter(page, demo.origin); await open(page); await inspectActive(page, 'Pending');
});

test('a stale second-tab simulation and chat approval fail closed and reload the real proposal', async ({ page, context, demo }) => {
  await enter(page, demo.origin); await open(page); await prepare(page, 'Pending');
  const other = await context.newPage();
  try {
    await other.goto(demo.origin);
    await other.getByRole('button', { name: 'Gather material references', exact: true }).click(); await open(other);
    await openSavedChanges(other);
    await expect(approval(other)).toBeEnabled();
    const stale = await savedLifecycle(other, demo.origin);
    await openSavedChanges(page);
    const divider = studio(page).getByRole('separator', { name: 'Resize conversation and proposal' });
    await divider.focus(); await divider.press('ArrowLeft'); await expect(divider).toHaveAttribute('aria-valuenow', '50');
    await prepare(page);
    const session = await (await other.request.get(demo.origin + '/api/session')).json();
    const rejected = await other.request.post(demo.origin + '/api/extensions/' + stale.extension.id + '/simulate', { headers: { origin: demo.origin, 'x-session-context': session.contextToken }, data: { revisionId: stale.revisionId, draftVersion: stale.draftVersion } });
    expect(rejected.status()).toBe(409);
    await approval(other).click();
    await expect(studio(other).getByRole('alert').filter({ hasText: 'saved proposal or selection changed' })).toBeVisible();
    await expect(studio(other).getByRole('status').filter({ hasText: 'Saved state reloaded' })).toBeVisible();
    await openSavedChanges(other);
    await expect(decision(other)).toContainText('Needs attention'); await inspectActive(other, 'Pending');
  } finally { await other.close(); }
});

test('an ineligible saved selection is unavailable and can be turned off', async ({ page, demo }) => {
  await enter(page, demo.origin);
  demo.invalidateSelectedAdvice();
  await open(page);
  const ui = studio(page);
  await expect(ui.getByLabel('Customization status')).toContainText('Couldn’t check what’s in use');
  expect((await savedLifecycle(page, demo.origin)).selection.eligible).toBe(false);
  await expect(ui.getByLabel('Customization status').getByText('In use', { exact: true })).toHaveCount(0);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice is unavailable' })).toBeVisible();
  await open(page);
  await openDetails(page);
  await ui.getByText('Manage saved customization', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expectOff(page);
});

const authoredProgram = JSON.stringify({ language: 'keir/v0', domain: { id: 'demo.tasks', version: '1',
  fingerprint: JSON.parse(readFileSync(new URL('../../extensions/task-read/selection.json', import.meta.url))).modelDigest },
  entrypoint: 'ClassifyTask', name: 'third-program', steps: [{ id: 'readTask', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } }],
  return: { record: { classification: { cel: 'readTask.status == "COMPLETED" ? "PENDING" : "DONE"' } } } });
const expectedExample = code => JSON.stringify({ format: 'keir-read-simulation/1', id: 'open', input: { taskId: 'sample-task' },
  stubs: [{ step: 'readTask', capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' },
    response: { kind: 'SUCCESS', value: { id: 'sample-task', status: 'OPEN' } } }],
  expect: { calls: [{ step: 'readTask', capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' } }],
    outcome: { classification: 'COMPLETED', result: { classification: code } }, consumption: { status: 'DISPLAYED', code } } });

async function reloadStudio(page) {
  await openDetails(page);
  await studio(page).getByRole('button', { name: 'Reload saved state', exact: true }).click();
  await expect(studio(page).getByLabel('Customization status', { exact: true })).toBeVisible();
  await closeDetails(page);
}
async function lifecyclePost(page, operation, data, origin = new URL(page.url()).origin) {
  const base = new URL(origin).origin, saved = await savedLifecycle(page, base);
  const { contextToken } = await (await page.request.get(base + '/api/session')).json();
  const response = await page.request.post(base + '/api/extensions/' + saved.extension.id + '/' + operation, {
    headers: { 'x-session-context': contextToken, origin: base }, data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function compileSaved(page, cases) {
  const saved = await savedLifecycle(page, page.url());
  const compiled = await lifecyclePost(page, 'compile', { source: authoredProgram, label: 'Different task advice', draftVersion: saved.draftVersion });
  if (!cases) return compiled;
  return lifecyclePost(page, 'scenarios', { revisionId: compiled.draft.id, cases: [cases], draftVersion: compiled.draftVersion });
}

for (const width of [1440, 390]) test(`real authored source, independent examples and saved-task activation ${width}`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved authored title');
  await open(page);
  const ui = studio(page);
  const compiled = await compileSaved(page);
  await reloadStudio(page);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
  await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText(authoredProgram);
  await expect(ui.getByText('Independent examples have not been saved for this source.', { exact: true })).toBeVisible();
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
  const session = await (await page.request.get(demo.origin + '/api/session')).json();
  const unchecked = await page.request.post(demo.origin + '/api/extensions/' + compiled.extension.id + '/simulate', { headers: { origin: demo.origin, 'x-session-context': session.contextToken }, data: { revisionId: compiled.revisionId, draftVersion: compiled.draftVersion } });
  expect(unchecked.status()).toBe(409); await expect(approval(page)).toHaveCount(0);
  await lifecyclePost(page, 'scenarios', { revisionId: compiled.draft.id, cases: [expectedExample('PENDING')], draftVersion: compiled.draftVersion });
  const failed = await checkSaved(page); expect(failed.evidence.passed).toBe(false);
  await latestExamples(page);
  await expect(ui.getByText('This example needs a correction', { exact: true })).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
  const mismatch = await savedLifecycle(page, demo.origin);
  await lifecyclePost(page, 'scenarios', { revisionId: mismatch.draft.id, cases: [expectedExample('DONE')], draftVersion: mismatch.draftVersion });
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  await expect(approval(page)).toBeEnabled();
  await expect(decision(page).locator('.rs-example:visible')).toHaveCount(1);
  await expect(ui.locator('.rs-example:visible')).toHaveCount(1);
  await expect(decision(page).getByText('Matches what you wanted', { exact: true })).toHaveCount(1);
  await approve(page);
  expect((await savedLifecycle(page, demo.origin)).selection.revision.label).toBe('Pending');
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved authored title');
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Done' })).toBeVisible();
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
  await expect(page.locator('.status-label.completed')).toHaveCount(0);
  await demo.restart();
  await enter(page, demo.origin);
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Done' })).toBeVisible();
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
});

async function authoredReady(page, origin, waitForReview = true) {
  await enter(page, origin); await open(page);
  await compileSaved(page, expectedExample('DONE'));
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  if (waitForReview) await expect(approval(page)).toBeEnabled();
  return studio(page);
}
async function savedLifecycle(page, origin) {
  const base = new URL(origin).origin;
  const { contextToken } = await (await page.request.get(base + '/api/session')).json();
  const response = await page.request.get(base + '/api/extensions', { headers: { 'x-session-context': contextToken } });
  expect(response.ok()).toBe(true);
  const collection = await response.json();
  expect(collection.items).toHaveLength(1);
  const state = await page.request.get(base + '/api/extensions/' + collection.items[0].extension.id, { headers: { 'x-session-context': contextToken } });
  expect(state.ok()).toBe(true);
  return state.json();
}

test('exact authored review shows saved A, preserves unsent conversation B, and reloads A after re-entry', async ({ page, demo }) => {
  const ui = await authoredReady(page, demo.origin);
  const saved = await savedLifecycle(page, demo.origin);
  const conversationB = 'Unsaved conversation B: explain this proposal before changing it.';
  await ui.getByLabel('Message to Studio').fill(conversationB);
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(authoredProgram);
  await expect(ui.getByLabel('Saved example 1 for approval', { exact: true })).toHaveText(expectedExample('DONE'));
  await expect(ui.getByLabel('Message to Studio')).toHaveValue(conversationB);
  await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  const approved = await savedLifecycle(page, demo.origin);
  expect(approved.draft.id).toBe(saved.draft.id);
  expect(approved.approvedEvidenceId).toBe(saved.evidence.id);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await open(page);
  await expect(ui.getByLabel('Message to Studio')).toHaveValue('');
  await openSavedChanges(page);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(authoredProgram);
  await expect(ui.getByLabel('Saved example 1 for approval', { exact: true })).toHaveText(expectedExample('DONE'));
  await expect(ui.getByLabel('Message to Studio')).toHaveValue('');
});

test('exact authored review fails closed on unavailable or mismatched saved documents and can retry', async ({ page, demo }) => {
  let mode = 'unavailable';
  await page.route('**/api/extensions/*/revisions/*', async route => {
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    const response = await route.fetch(), saved = await response.json();
    await route.fulfill({ response, json: mode === 'revision' ? { ...saved, revisionId: 'wrong-revision' } : mode === 'suite' ? { ...saved, suiteDigest: 'wrong-suite' } : saved });
  });
  const ui = await authoredReady(page, demo.origin, false);
  for (const next of ['revision', 'suite', 'valid']) {
    await expect(decision(page).getByText(/exact saved change and its examples could not be confirmed/)).toBeVisible();
    await expect(approval(page)).toHaveCount(0);
    await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveCount(0);
    mode = next; await ui.getByRole('button', { name: 'Check saved change again', exact: true }).click();
  }
  await expect(approval(page)).toBeEnabled();
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(authoredProgram);
  expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
});

test('a held exact-source review cannot enter a different owner or a re-entered workspace', async ({ page, context, demo }) => {
  let release, arrived, delivered, heldOnce = false;
  const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions/*/revisions/*', async route => {
    if (heldOnce) return route.continue();
    heldOnce = true;
    const response = await route.fetch(); arrived(); await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* Workspace replacement aborts the old read. */ }
    delivered();
  });
  const ui = await authoredReady(page, demo.origin, false), other = await context.newPage();
  try {
    await started; await expect(approval(page)).toHaveCount(0);
    await other.goto(demo.origin); await other.getByLabel('Demo person', { exact: true }).selectOption('leo');
    await expect(page.getByRole('button', { name: 'Continue as Leo' })).toBeVisible();
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue as Leo' }).click();
    await page.getByLabel('Demo person', { exact: true }).selectOption('maya');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya'); await tasks(page);
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click(); await open(page);
    release(); await finished; await page.unroute('**/api/extensions/*/revisions/*');
    expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
    await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
    await openSavedChanges(page);
    await expect(approval(page)).toBeEnabled();
    await ui.getByText('Exact saved change and checks', { exact: true }).click();
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(authoredProgram);
    expect((await savedLifecycle(page, demo.origin)).approvedEvidenceId).toBe(null);
  } finally { release?.(); await other.close(); }
});

const cancellation = base.extend({
  controlled: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-author-cancel-')), db = openData(join(directory, 'app.sqlite'));
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    let mode = 'hold', started, child, closed = 0, compilations = 0;
    const begun = new Promise(resolve => { started = resolve; });
    const app = await createApp({ db, origin, compiler: { compile: async (_, { signal }) => {
      compilations++;
      if (mode === 'immediate') return { artifact: loadCatalog()[0].artifactBytes, diagnostics: [] };
      // Real owned child tests HTTP/AbortSignal settlement; actual JAR behavior is covered separately.
      return new Promise((resolve, reject) => {
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        const stop = () => child.kill();
        signal.addEventListener('abort', stop, { once: true });
        child.once('spawn', () => { started(); if (signal.aborted) stop(); });
        child.once('error', reject);
        child.once('close', () => { closed++; signal.removeEventListener('abort', stop); reject(Object.assign(new Error('Cancelled fixture'), { status: 499 })); });
      });
    } } });
    await app.listen({ host: '127.0.0.1', port });
    try { await use({ origin, begun, get closed() { return closed; }, get compilations() { return compilations; },
      immediate() { mode = 'immediate'; }, saved: () => db.prepare("SELECT draft_version FROM extensions WHERE owner_id='maya'").get().draft_version }); }
    finally { if (child && child.exitCode === null && child.signalCode === null) child.kill(); await app.close(); db.close(); rmSync(directory, { recursive: true }); }
  },
});

// Authoring Stop controls are exercised in authoring.spec.mjs; this checks the native compiler disconnect boundary.
cancellation('real HTTP cancellation settles the compiler child and reads back before retry or after-commit claims', async ({ page, controlled }) => {
  await enter(page, controlled.origin);
  const { contextToken } = await (await page.request.get(controlled.origin + '/api/session')).json();
  const extensionId = (await savedLifecycle(page, controlled.origin)).extension.id;
  async function beginCompile() {
    await page.evaluate(({ token, extensionId }) => {
      window.compileController = new AbortController();
      window.compileResult = fetch('/api/extensions/' + extensionId + '/compile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': token },
        body: JSON.stringify({ source: 'Cancellation transport fixture', draftVersion: 0 }), signal: window.compileController.signal }).catch(error => error.name);
    }, { token: contextToken, extensionId });
  }
  await beginCompile(); await controlled.begun;
  await page.evaluate(() => window.compileController.abort());
  await expect.poll(() => controlled.closed).toBe(1);
  expect(await page.evaluate(() => window.compileResult)).toBe('AbortError');
  expect((await savedLifecycle(page, controlled.origin)).draftVersion).toBe(0);
  expect(controlled.saved()).toBe(0);

  controlled.immediate();
  let committed, releaseResponse;
  const saved = new Promise(resolve => { committed = resolve; }), responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await page.route('**/api/extensions/*/compile', async route => {
    const response = await route.fetch(); committed(); await responseGate; await route.fulfill({ response }).catch(() => {});
  });
  try {
    await beginCompile(); await saved;
    expect(controlled.saved()).toBe(1);
    await page.evaluate(() => window.compileController.abort());
    expect(await page.evaluate(() => window.compileResult)).toBe('AbortError');
    const readback = await savedLifecycle(page, controlled.origin);
    expect(readback.draftVersion).toBe(1);
    expect(readback.draft.kind).toBe('authored');
    expect(controlled.compilations).toBe(2);
    expect(controlled.saved()).toBe(1);
  } finally { releaseResponse?.(); }
});
