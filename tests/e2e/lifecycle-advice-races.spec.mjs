import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-advice-race-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const server = await start({ directory, port });
    try { await use(server); }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function openDetails(page) {
  await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
}
async function savedState(page) {
  return page.evaluate(async () => {
    const id = new URLSearchParams(location.hash.slice(1)).get('customization');
    if (!id) throw new Error('The saved customization must be explicitly targeted.');
    const session = await (await fetch('/api/session')).json();
    return (await fetch(`/api/extensions/${id}`, { headers: { 'X-Session-Context': session.contextToken } })).json();
  });
}
async function prepareChoice(page, label) {
  const before = await savedState(page), templateId = label === 'Pending' ? 'pending' : 'attention';
  const result = await page.evaluate(async ({ extensionId, templateId, draftVersion }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(`/api/extensions/${extensionId}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken },
      body: JSON.stringify({ templateId, draftVersion }) });
    return { ok: response.ok };
  }, { extensionId: before.extension.id, templateId, draftVersion: before.draftVersion });
  expect(result.ok).toBeTruthy();
  await openDetails(page);
  await studio(page).getByRole('button', { name: 'Reload saved state', exact: true }).click();
  await expect.poll(async () => (await savedState(page)).draft?.templateId).toBe(templateId);
}
async function enter(page, origin, choice = 'Pending') {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(page).toHaveURL(/#customization=[^&]+/);
  await prepareChoice(page, choice);
  await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(studio(page).getByLabel('Message to Studio')).toBeVisible();
  await expect(studio(page).getByRole('button', { name: /Pending for open tasks|Needs attention for open tasks/ })).toHaveCount(0);
}

test('an actual already-produced unavailable advice receipt cannot overwrite a restored selection or unsaved edit', async ({ page, demo }) => {
  await enter(page, demo.origin);
  const extensionId = (await savedState(page)).extension.id;
  await openDetails(page);
  await studio(page).getByText('Manage saved customization', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  expect((await savedState(page)).selection.revision).toBeNull();
  await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Retain unsaved race edit');
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/*/advice', async route => {
    const response = await route.fetch();
    expect((await response.json()).status).toBe('NOT_DISPLAYED');
    arrived(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }); delivered();
  });
  try {
    await page.getByRole('button', { name: 'Check task advice', exact: true }).click(); await started;
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.locator(`#edit-${extensionId}`).click();
    await openDetails(page);
    const manage = studio(page).getByRole('group', { name: 'Manage saved customization', exact: true });
    if (!await manage.evaluate(node => node.open)) await manage.locator(':scope > summary').click();
    const select = studio(page).getByLabel('Previously in use');
    const option = select.locator('option').filter({ hasText: 'Pending · operator starting choice' });
    await select.selectOption(await option.getAttribute('value'));
    await studio(page).getByRole('button', { name: 'Restore Pending for me', exact: true }).click();
    await expect.poll(async () => (await savedState(page)).selection.revision?.templateId).toBe('pending');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    release(); await finished;
    await page.unroute('**/api/tasks/*/advice');
    await expect(page.getByText('Task advice is unavailable. Your task has not changed.', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Retain unsaved race edit');
    await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Task advice: Pending' })).toBeVisible();
  } finally { release?.(); }
});

test('a late actual simulation receipt cannot enter a new owner workspace after a cross-tab switch', async ({ page, context, demo }) => {
  await enter(page, demo.origin, 'Needs attention');
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions/*/simulate', async route => {
    const response = await route.fetch(); expect((await response.json()).evidence.passed).toBe(true);
    arrived(); await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* Owner switch aborts the abandoned request. */ }
    delivered();
  });
  const other = await context.newPage();
  try {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await studio(page).getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
    await studio(page).getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click(); await started;
    await other.goto(demo.origin); await other.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('button', { name: 'Continue as Leo' })).toBeVisible();
    release(); await finished; await page.unroute('**/api/extensions/*/simulate');
    await page.getByRole('button', { name: 'Continue as Leo' }).click();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('leo');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await expect(studio(page).locator('.rs-example')).toHaveCount(0);
    await expect(studio(page).getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    expect((await savedState(page)).selection.revision.templateId).toBe('attention');
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
  } finally { release?.(); await other.close(); }
});
