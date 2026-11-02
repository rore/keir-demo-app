import { test as base, expect } from '@playwright/test';
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
        invalidateSelectedAdvice: () => server.db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya')").run() });
    } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
async function openDetails(page) {
  if (await studio(page).locator('.rs-preview').isHidden()) {
    await studio(page).getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
    return;
  }
  const collapsed = studio(page).locator('details.rs-tools:not([open]) > summary');
  if (await collapsed.count()) await collapsed.click();
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
}
const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
async function open(page) {
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page).getByRole('button', { name: 'View proposal', exact: true })).toBeEnabled();
  if (page.viewportSize().width > 1120 && page.viewportSize().height > 650) await studio(page).getByRole('button', { name: 'View proposal', exact: true }).click();
  expect(await studio(page).locator('.rs-composer').evaluate(form => form.getBoundingClientRect().height)).toBeLessThan(180);
  expect(await studio(page).locator('.rs-header').evaluate(header => header.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
}
async function prepare(page, label = 'Needs attention') {
  const ui = studio(page);
  await ui.getByRole('button', { name: `${label} for open tasks`, exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Proposed advice' }).getByRole('heading', { name: label, exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Try on sample tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Latest run', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  await expect(ui.getByRole('table').locator('tbody tr')).toHaveCount(6);
  await expect(ui.getByRole('cell', { name: /^Matches/ })).toHaveCount(6);
}
async function approve(page) {
  const ui = studio(page);
  await ui.getByRole('button', { name: 'Review this advice', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Approve this advice', exact: true })).toBeDisabled();
  await ui.getByRole('button', { name: 'Review', exact: true }).click();
  await ui.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await ui.getByRole('button', { name: 'Approve this advice', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Use this advice for me', exact: true })).toBeEnabled();
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
  await expect(studio(page).getByText('Advice for Maya', { exact: true })).toBeVisible();
  await prepare(page);
  const ui = studio(page);
  await ui.getByLabel('Message to Studio').fill('Yes, use this advice');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('For Maya only', { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Approve this advice', exact: true })).toBeDisabled();
  await expect(ui.getByRole('button', { name: 'Use this advice for me', exact: true })).toHaveCount(0);
  await ui.getByRole('button', { name: 'Advice', exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Review', exact: true }).click();
  await ui.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await ui.getByRole('button', { name: 'Approve this advice', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Use this advice for me', exact: true })).toBeEnabled();
  await ui.getByRole('button', { name: 'View proposal', exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Use this advice for me', exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  await picture(page, 'read-lifecycle-desktop');
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage task advice', exact: true })).toBeFocused();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task needs attention' })).toBeVisible();
  await open(page);
  await openDetails(page);
  await ui.getByText('Manage saved advice', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task needs attention' })).toHaveCount(0);
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task needs attention' })).toBeVisible();
});

test('lost activation response is read back before retry; historical evidence cannot approve a new draft', async ({ page, demo }) => {
  await enter(page, demo.origin); await open(page); await prepare(page); await approve(page);
  const ui = studio(page);
  let requests = 0;
  await page.route('**/api/extensions/activate', async route => { requests++; await route.fetch(); await route.abort('failed'); });
  await ui.getByRole('button', { name: 'Use this advice for me', exact: true }).click();
  await expect(ui.getByRole('status').filter({ hasText: 'Saved state reloaded' })).toBeVisible();
  await ui.getByRole('button', { name: 'View proposal', exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await page.unroute('**/api/extensions/activate');
  await ui.getByRole('button', { name: 'Change choice', exact: true }).click();
  await ui.getByRole('button', { name: 'Pending for open tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Sample results', exact: true }).click();
  await expect(ui.getByText('Saved sample run · Earlier proposal', { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
  await ui.getByRole('button', { name: 'Review 6 examples', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
  await expect(ui.getByRole('button', { name: 'Approve this advice', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await open(page);
  await openDetails(page);
  await ui.getByText('Saved sample runs', { exact: true }).click();
  await ui.getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  await expect(ui.getByText('Saved sample run · Earlier proposal', { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
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
    await studio(page).getByText('Manage saved advice', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Turn off my advice', exact: true }).click();
    await expect(studio(page).getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    release(); await finished;
    await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'This task is pending' })).toHaveCount(0);
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this edit');
  } finally { release?.(); }
});

test('narrow Studio reviews a named operator restore and keeps it after server restart', async ({ page, demo }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, demo.origin); await open(page);
  const ui = studio(page);
  await ui.getByRole('button', { name: 'View proposal', exact: true }).click();
  await openDetails(page);
  await ui.getByText('Manage saved advice', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
  const option = ui.getByLabel('Previously in use').locator('option').filter({ hasText: 'Pending · operator starting choice' });
  await ui.getByLabel('Previously in use').selectOption(await option.getAttribute('value'));
  await expect(ui.getByText('This was an operator-provided starting choice.', { exact: false })).toBeVisible();
  await expect(ui.getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Restore Pending for me', exact: true }).click();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
  await picture(page, 'read-lifecycle-narrow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await demo.restart();
  await enter(page, demo.origin); await open(page);
  await studio(page).getByRole('button', { name: 'View proposal', exact: true }).click();
  await expect(studio(page).getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
});

test('a stale second-tab draft request reloads the real proposal after conflict', async ({ page, context, demo }) => {
  await enter(page, demo.origin); await open(page);
  const other = await context.newPage();
  try {
    await other.goto(demo.origin);
    await other.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await open(other);
    const divider = studio(page).getByRole('separator', { name: 'Resize conversation and advice' });
    await divider.focus(); await divider.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    await studio(page).getByRole('button', { name: 'Needs attention for open tasks', exact: true }).click();
    await expect(studio(page).getByRole('article', { name: 'Proposed advice' }).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
    await studio(other).getByRole('button', { name: 'Pending for open tasks', exact: true }).click();
    await expect(studio(other).getByRole('alert')).toContainText('saved proposal or selection changed');
    await expect(studio(other).getByRole('status').filter({ hasText: 'Saved state reloaded' })).toBeVisible();
    await expect(studio(other).getByRole('article', { name: 'Proposed advice' }).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
    await expect(studio(other).getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
  } finally { await other.close(); }
});

test('an ineligible saved selection is unavailable and can be turned off', async ({ page, demo }) => {
  await enter(page, demo.origin);
  demo.invalidateSelectedAdvice();
  await open(page);
  const ui = studio(page);
  await expect(ui.getByRole('article', { name: 'Current advice' })).toContainText('Your saved Pending choice could not be validated');
  await expect(ui.getByRole('heading', { name: 'Advice is unavailable', exact: true })).toBeVisible();
  await expect(ui.getByRole('article', { name: 'Current advice' }).getByText('In use', { exact: true })).toHaveCount(0);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task advice is unavailable' })).toBeVisible();
  await open(page);
  await openDetails(page);
  await ui.getByText('Manage saved advice', { exact: true }).click();
  await ui.getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
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

async function developer(page) {
  await openDetails(page);
  const summary = studio(page).locator('.rs-developer > summary');
  if (!await studio(page).locator('.rs-developer').evaluate(node => node.open)) await summary.click();
  return studio(page).locator('.rs-developer');
}

for (const width of [1440, 390]) test(`real authored source, independent examples and saved-task activation ${width}`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved authored title');
  await open(page); await developer(page);
  const ui = studio(page);
  await ui.getByLabel('Program label', { exact: true }).fill('Different task advice');
  await ui.getByLabel('Keir source (developer)', { exact: true }).fill(authoredProgram);
  await ui.getByRole('button', { name: 'Compile source', exact: true }).click();
  await expect(ui.getByText('Saved source is waiting for independent examples.', { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Try on sample tasks', exact: true })).toBeDisabled();
  await ui.getByLabel('Example 1 JSON', { exact: true }).fill(expectedExample('PENDING'));
  await ui.getByRole('button', { name: 'Save expected examples', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Try on sample tasks', exact: true })).toBeEnabled();
  await ui.getByRole('button', { name: 'Try on sample tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Latest run', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run did not pass', exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
  await developer(page);
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveValue(authoredProgram);
  await ui.getByLabel('Example 1 JSON', { exact: true }).fill(expectedExample('DONE'));
  await ui.getByRole('button', { name: 'Save expected examples', exact: true }).click();
  await ui.getByRole('button', { name: 'Try on sample tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Latest run', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  await ui.getByRole('button', { name: 'Review this advice', exact: true }).click();
  await ui.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await ui.getByRole('button', { name: 'Approve this advice', exact: true }).click();
  await expect(ui.getByText('In use · Pending', { exact: true })).toHaveCount(1);
  await ui.getByRole('button', { name: 'Use this advice for me', exact: true }).click();
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved authored title');
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task is completed' })).toBeVisible();
  await demo.restart();
  await enter(page, demo.origin);
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task is completed' })).toBeVisible();
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task needs attention' })).toBeVisible();
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
      immediate() { mode = 'immediate'; }, saved: () => db.prepare("SELECT draft_version FROM extension_states WHERE owner_id='maya'").get().draft_version }); }
    finally { if (child && child.exitCode === null && child.signalCode === null) child.kill(); await app.close(); db.close(); rmSync(directory, { recursive: true }); }
  },
});

cancellation('developer Stop reaches real HTTP abort, closes the child, and reads back before retry or after-commit claims', async ({ page, controlled }) => {
  await enter(page, controlled.origin); await open(page); await developer(page);
  const ui = studio(page);
  await ui.getByLabel('Keir source (developer)', { exact: true }).fill('Cancellation transport fixture');
  await ui.getByRole('button', { name: 'Compile source', exact: true }).click(); await controlled.begun;
  let releaseRead, readStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; }), seenRead = new Promise(resolve => { readStarted = resolve; });
  await page.route('**/api/extensions', async route => { const response = await route.fetch(); readStarted(); await readGate; await route.fulfill({ response }); });
  await ui.getByRole('button', { name: 'Stop preparation', exact: true }).click();
  await seenRead;
  await expect.poll(() => controlled.closed).toBe(1);
  await expect(ui.getByRole('button', { name: 'Compile source', exact: true })).toBeDisabled();
  releaseRead();
  await expect(ui.getByRole('button', { name: 'Compile source', exact: true })).toBeEnabled();
  expect(controlled.saved()).toBe(0);
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveValue('Cancellation transport fixture');
  await page.unroute('**/api/extensions');

  controlled.immediate();
  let committed, releaseResponse;
  const saved = new Promise(resolve => { committed = resolve; }), responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await page.route('**/api/extensions/compile', async route => {
    const response = await route.fetch(); committed(); await responseGate; await route.fulfill({ response }).catch(() => {});
  });
  await ui.getByRole('button', { name: 'Compile source', exact: true }).click(); await saved;
  expect(controlled.saved()).toBe(1);
  await ui.getByRole('button', { name: 'Stop preparation', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Compile source', exact: true })).toBeEnabled();
  await expect(ui.getByText('Saved source is waiting for independent examples.', { exact: true })).toBeVisible();
  expect(controlled.compilations).toBe(2);
  expect(controlled.saved()).toBe(1);
  releaseResponse();
});
