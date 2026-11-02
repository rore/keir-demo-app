import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-browser-'));
    const port = await freePort();
    let server = await start({ directory, port });
    try { await use({ origin: server.origin, restart: async () => { await server.close(); server = await start({ directory, port }); } }); }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
const pictures = resolve('build/screens');
async function screenshot(page, name) { mkdirSync(pictures, { recursive: true }); await page.screenshot({ path: join(pictures, `${name}.png`), fullPage: true }); }
async function signIn(page, name) {
  await page.getByRole('button', { name: `Continue as ${name}` }).click();
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue(name.toLowerCase());
  await expect(page.getByRole('status').filter({ hasText: 'Gathering your tasks' })).toHaveCount(0);
}
async function newProject(page, name, mobile = false) {
  await page.getByRole('button', { name: mobile ? 'Add project' : 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

test('task advice uses saved per-user rules, preserves edits and clears failed or stale detail results', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Unsaved title stays');
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task is pending' })).toBeVisible();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved title stays');
  await page.route('**/api/tasks/*/advice', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'NOT_DISPLAYED', message: 'Task advice is unavailable. Your task has not changed.' }) }));
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByText('This task is pending', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Task advice is unavailable' })).toBeVisible();
  await page.unroute('**/api/tasks/*/advice');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/tasks/*/advice', async route => {
    const response = await route.fetch();
    entered();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await started;
  await expect(page.getByText('Task advice is unavailable', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toBeEnabled();
  await expect(page.getByText('This task is pending', { exact: false })).toHaveCount(0);
  await page.unroute('**/api/tasks/*/advice');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Complete Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task is completed' })).toBeVisible();
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await expect(page.getByRole('status').filter({ hasText: 'Gathering your tasks' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This task needs attention' })).toBeVisible();
  await screenshot(page, 'task-advice');
});

test('task advice response pending across a user switch never enters the new workspace', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  let release, entered, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/*/advice', async route => {
    const response = await route.fetch(); entered();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response });
    delivered();
  });
  await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await expect(page.getByRole('button', { name: 'Plan the Saturday session', exact: true })).toBeVisible();
  release();
  await finished;
  await page.unroute('**/api/tasks/*/advice');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await expect(page.getByText('This task is pending', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toBeEnabled();
});

test('three people create, rename, edit and complete tasks; all data survives real server restart', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await expect(page.getByRole('heading', { name: 'Choose a demo person.', exact: true })).toBeVisible();
  await screenshot(page, 'welcome-desktop');
  for (const name of ['Maya', 'Leo', 'Sam']) {
    await signIn(page, name);
    if (name === 'Maya') await screenshot(page, 'tasks-desktop');
    await newProject(page, `${name} project`);
    await expect(page.getByText('Room for something good.')).toBeVisible();
    await page.getByRole('button', { name: 'Rename project' }).click();
    await page.getByLabel('Project name', { exact: true }).fill(`${name} notebook`);
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.getByLabel('New task title').fill(`${name} task`);
    await page.getByRole('button', { name: 'Add task', exact: false }).click();
    await page.getByRole('button', { name: `${name} task`, exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill(`${name} finished task`);
    await page.getByLabel('Notes (optional)').fill('A real saved note, without AI.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: `Complete ${name} finished task`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${name} finished task, completed`, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Continue as Maya' })).toBeVisible();
  }
  await demo.restart();
  await page.reload();
  for (const name of ['Maya', 'Leo', 'Sam']) {
    await signIn(page, name);
    await page.getByRole('button', { name: new RegExp(`${name} notebook$`) }).click();
    await expect(page.getByRole('button', { name: `${name} finished task, completed`, exact: true })).toBeVisible();
    for (const other of ['Maya', 'Leo', 'Sam'].filter(other => other !== name)) await expect(page.getByText(`${other} finished task`, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
});

test('mobile, keyboard/detail focus, empty, validation and API error states', async ({ page, demo }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo.origin); await signIn(page, 'Maya');
  await screenshot(page, 'tasks-mobile');
  const first = page.getByRole('button', { name: 'Gather material references', exact: true });
  await first.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(first).toBeFocused();
  await first.click(); await page.getByLabel('Task title', { exact: true }).fill(' ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('dialog [role=alert]')).toContainText('Task title must be 1');
  await screenshot(page, 'task-validation-mobile');
  await page.keyboard.press('Escape');
  await newProject(page, 'A blank page', true); await screenshot(page, 'empty-mobile');
  await page.route('**/api/tasks', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The local database could not be reached. Please try again.' }) }));
  await page.getByLabel('New task title').fill('Keep my draft'); await page.getByRole('button', { name: 'Add task', exact: false }).click();
  await expect(page.getByRole('alert')).toContainText('The local database could not be reached.');
  await expect(page.getByLabel('New task title')).toHaveValue('Keep my draft');
  await screenshot(page, 'api-error-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('delayed old data cannot repopulate a switched scope and expired API cannot clear a new cookie', async ({ page, context, demo }) => {
  await page.goto(demo.origin); await signIn(page, 'Maya');
  const oldScope = await page.evaluate(async () => (await fetch('/api/session')).json());
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/projects/*/tasks', async route => {
    const response = await route.fetch(); started(); await gate;
    try { await route.fulfill({ response }); } catch { /* The abandoned A request may already be aborted. */ }
  });
  await page.reload(); await intercepted;
  await expect(page.getByText('Gathering your tasks…')).toBeVisible(); await screenshot(page, 'loading-desktop');
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.unroute('**/api/projects/*/tasks'); release();
  await expect(page.getByRole('heading', { level: 1, name: 'Neighbourhood workshop' })).toBeVisible();
  await expect(page.getByText('Gather material references', { exact: true })).toHaveCount(0);
  const stale = await page.evaluate(async token => {
    const response = await fetch('/api/projects', { headers: { 'X-Session-Context': token } });
    return response.status;
  }, oldScope.contextToken);
  expect(stale).toBe(401);
  expect((await context.cookies()).find(cookie => cookie.name === 'keir_demo_session')).toBeTruthy();
  expect(await page.evaluate(async () => (await (await fetch('/api/session')).json()).user.id)).toBe('leo');
});

test('authentication transitions serialize across tabs even when the first cookie response is delayed', async ({ page, context, demo }) => {
  await page.goto(demo.origin); await signIn(page, 'Maya');
  const second = await context.newPage(); await second.goto(demo.origin);
  await expect(second.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('maya');
  // Finish initial owner reads before the deliberately delayed cookie transition.
  await expect(second.getByRole('button', { name: 'Gather material references', exact: true })).toBeVisible();
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { observed = resolve; });
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo'); await intercepted;
  await second.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam');
  await expect(second.getByRole('status').filter({ hasText: 'Opening your space' })).toBeVisible();
  release();
  await expect(second.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
  await expect(second.getByRole('heading', { level: 1, name: 'A quieter workspace' })).toBeVisible();
  expect(await second.evaluate(async () => (await (await fetch('/api/session')).json()).user.id)).toBe('sam');
  await expect(page.getByText('The demo person changed in another tab. Choose a person to continue.')).toBeVisible();
  await screenshot(page, 'session-changed-desktop');
});

for (const nextTask of ['Refine the packaging sketches', 'Gather material references']) {
  test(`delayed save cannot close a newer panel draft: ${nextTask}`, async ({ page, demo }) => {
    await page.goto(demo.origin); await signIn(page, 'Maya');
    let release, observed;
    const gate = new Promise(resolve => { release = resolve; });
    const intercepted = new Promise(resolve => { observed = resolve; });
    await page.route('**/api/tasks/*', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Saved first task');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await intercepted;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: nextTask, exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Newer unsaved draft');
    const response = page.waitForResponse(response => response.request().method() === 'PATCH');
    release(); await response;
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Newer unsaved draft');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved first task', exact: true })).toBeVisible();
  });
}

test('initial project list must finish before project creation becomes available', async ({ page, demo }) => {
  await page.goto(demo.origin);
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { observed = resolve; });
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await intercepted;
  try {
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  } finally { release(); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await newProject(page, 'Newest project');
  await expect(page.getByRole('button', { name: /Newest project$/ })).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { level: 1, name: 'Newest project', exact: true })).toBeVisible();
});
