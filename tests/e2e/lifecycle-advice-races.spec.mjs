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
const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
async function openDetails(page) {
  const collapsed = studio(page).locator('details.rs-tools:not([open]) > summary');
  if (await collapsed.count()) await collapsed.click();
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page).getByRole('button', { name: 'Pending for open tasks', exact: true })).toBeEnabled();
}

test('an actual already-produced unavailable advice receipt cannot overwrite a restored selection or unsaved edit', async ({ page, demo }) => {
  await enter(page, demo.origin);
  await openDetails(page);
  await studio(page).getByText('Manage saved advice', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Turn off my advice', exact: true }).click();
  await expect(studio(page).getByRole('heading', { name: 'Advice is off', exact: true })).toBeVisible();
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
    await openDetails(page);
    await studio(page).getByText('Manage saved advice', { exact: true }).click();
    const select = studio(page).getByLabel('Previously in use');
    const option = select.locator('option').filter({ hasText: 'Pending · operator starting choice' });
    await select.selectOption(await option.getAttribute('value'));
    await studio(page).getByRole('button', { name: 'Restore Pending for me', exact: true }).click();
    await expect(studio(page).getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Pending', exact: true })).toBeVisible();
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    release(); await finished;
    await page.unroute('**/api/tasks/*/advice');
    await expect(page.getByText('Task advice is unavailable. Your task has not changed.', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Retain unsaved race edit');
    await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'This task is pending' })).toBeVisible();
  } finally { release?.(); }
});

test('a late actual simulation receipt cannot enter a new owner workspace after a cross-tab switch', async ({ page, context, demo }) => {
  await enter(page, demo.origin);
  await studio(page).getByRole('button', { name: 'Needs attention for open tasks', exact: true }).click();
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions/simulate', async route => {
    const response = await route.fetch(); expect((await response.json()).evidence.passed).toBe(true);
    arrived(); await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* Owner switch aborts the abandoned request. */ }
    delivered();
  });
  const other = await context.newPage();
  try {
    await studio(page).getByRole('button', { name: 'Try on sample tasks', exact: true }).click(); await started;
    await other.goto(demo.origin); await other.getByLabel('Demo person').selectOption('leo');
    await expect(page.getByRole('button', { name: 'Continue as Leo' })).toBeVisible();
    release(); await finished; await page.unroute('**/api/extensions/simulate');
    await page.getByRole('button', { name: 'Continue as Leo' }).click();
    await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await expect(studio(page).getByRole('heading', { name: 'Sample run passed', exact: true })).toHaveCount(0);
    await expect(studio(page).getByRole('article', { name: 'Current advice' }).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  } finally { release?.(); await other.close(); }
});
