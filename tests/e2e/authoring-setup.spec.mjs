import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

// UI protocol coverage only: authoring and setup responses are scripted; this does not qualify persistence or a live provider.
const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-setup-ui-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let server;
    try { server = await start({ directory, port }); await use({ origin: server.origin }); }
    finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});

const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
const authoring = page => studio(page).getByRole('region', { name: 'AI authoring', exact: true });
const choices = [
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
];
const unavailable = { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null };

function setupDto({ provider = null, model = null, maxUsd = null } = {}) {
  const ready = !!provider;
  return {
    configuration: { status: ready ? 'ready' : 'unavailable', code: ready ? null : 'AI_NOT_CONFIGURED',
      source: ready ? 'local' : 'none', provider, model, maxUsd },
    choices,
    availability: ready ? { available: true, code: null, provider, model } : unavailable,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function scriptSetup(page, options = {}) {
  const calls = { authoringReads: 0, setupReads: 0, setupPosts: [], syntheticKeys: [], turns: [] };
  const state = { projection: setupDto(), availability: unavailable };
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/api/authoring' && method === 'GET') {
      calls.authoringReads++;
      const result = options.onAuthoringRead ? await options.onAuthoringRead(calls, state) : null;
      if (result?.status) return json(route, result.body ?? { message: 'Scripted status failure' }, result.status);
      return json(route, result ?? { availability: state.availability, conversations: [], current: null });
    }
    if (url.pathname === '/api/authoring/setup' && method === 'GET') {
      calls.setupReads++;
      const result = options.onSetupRead ? await options.onSetupRead(calls, state) : null;
      if (result?.status) return json(route, result.body ?? { message: 'Scripted setup read failure' }, result.status);
      return json(route, result ?? state.projection);
    }
    if (url.pathname === '/api/authoring/setup' && method === 'POST') {
      const body = request.postDataJSON(); calls.setupPosts.push(body); calls.syntheticKeys.push(body.apiKey);
      if (options.onSetupSave) return options.onSetupSave(route, body, calls, state);
      state.projection = setupDto(body);
      state.availability = state.projection.availability;
      return json(route, state.projection);
    }
    if (url.pathname === '/api/authoring/turn' && method === 'POST') {
      calls.turns.push(request.postDataJSON());
      return json(route, { message: 'Unexpected generation request' }, 500);
    }
    return json(route, { message: 'Unexpected authoring request' }, 404);
  });
  return { calls, state };
}

async function enterStudio(page, origin, user = 'Maya') {
  await page.goto(origin);
  await page.getByRole('button', { name: `Continue as ${user}` }).click();
  await page.getByRole('button', { name: user === 'Maya' ? 'Gather material references' : 'Plan the Saturday session', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved task title');
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page)).toBeVisible();
  await expect(authoring(page)).toBeVisible();
}

async function openConfigure(page) {
  const ui = studio(page), configure = ui.getByRole('button', { name: 'Configure', exact: true });
  if (!await configure.isVisible()) {
    const details = ui.getByRole('button', { name: 'Details', exact: true });
    if (await details.isVisible()) await details.click();
    else await ui.getByRole('button', { name: 'Manage', exact: true }).click();
    const tools = ui.locator('details.rs-tools');
    if (!await tools.evaluate(node => node.open)) await tools.locator(':scope > summary').click();
  }
  await configure.click();
  return page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
}

async function noSecretInBrowser(page, secret) {
  const values = await page.evaluate(() => ({
    text: document.body.innerText,
    storage: [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'),
  }));
  expect(values.text).not.toContain(secret);
  expect(values.storage).not.toContain(secret);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`Configure validates, saves safely, and preserves chat and native edits at ${viewport.width}x${viewport.height}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    const { calls } = await scriptSetup(page);
    await enterStudio(page, demo.origin);
    const ui = studio(page), composer = ui.getByLabel('Message to Studio', { exact: true });
    await composer.fill('Keep this unsent authoring message');
    await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toHaveCount(1);
    const dialog = await openConfigure(page);
    await expect(dialog.getByText('These settings are shared by all three people in this demo. Each person keeps their own customizations.', { exact: true })).toBeVisible();
    const service = dialog.getByLabel('Service', { exact: true }), model = dialog.getByLabel('Model', { exact: true });
    await expect(service.locator('option')).toHaveText(['openai', 'anthropic']);
    await expect(model.locator('option')).toHaveText(['gpt-5.6-terra']);
    await service.selectOption('anthropic');
    await expect(model.locator('option')).toHaveText(['claude-haiku-5-5']);
    await service.selectOption('openai');
    await expect(model.locator('option')).toHaveText(['gpt-5.6-terra']);
    const key = dialog.getByLabel('API key', { exact: true }), allowance = dialog.getByLabel('Shared allowance (USD)', { exact: true });
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('autocomplete', 'off');
    const save = dialog.getByRole('button', { name: 'Save settings', exact: true });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('Enter an API key');
    await expect(key).toBeFocused();
    expect(calls.setupPosts).toHaveLength(0);
    await key.fill('synthetic-ui-validation-key');
    await allowance.fill('0');
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('positive USD allowance');
    await expect(allowance).toBeFocused();
    await allowance.fill('1.0000001');
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('positive USD allowance');
    await expect(allowance).toBeFocused();
    expect(calls.setupPosts).toHaveLength(0);

    const fields = dialog.locator('.rs-setup-fields');
    if (viewport.height <= 500) {
      expect(await fields.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await allowance.scrollIntoViewIfNeeded();
      await expect(allowance).toBeInViewport();
      await expect(save).toBeInViewport();
    }
    await dialog.getByLabel('Service', { exact: true }).focus(); await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Model', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(key).toBeFocused();
    await page.keyboard.press('Tab'); await expect(allowance).toBeFocused();
    await page.keyboard.press('Tab'); await expect(save).toBeFocused();

    const escapeSecret = 'synthetic-ui-escape-key';
    await key.fill(escapeSecret);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
    await noSecretInBrowser(page, escapeSecret);
    const reopened = await openConfigure(page);
    await expect(reopened.getByLabel('API key', { exact: true })).toHaveValue('');
    const cancelSecret = 'synthetic-ui-cancel-key';
    await reopened.getByLabel('API key', { exact: true }).fill(cancelSecret);
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(reopened).toBeHidden();
    await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
    await noSecretInBrowser(page, cancelSecret);

    const savingDialog = await openConfigure(page), savingKey = savingDialog.getByLabel('API key', { exact: true });
    await expect(savingKey).toHaveValue('');
    const secret = 'synthetic-ui-success-key';
    await savingKey.fill(secret);
    await savingDialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('0.125000');
    await savingDialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(savingDialog).toBeHidden();
    await expect(ui.getByRole('status').filter({ hasText: 'Settings saved. Send a message when you’re ready.' })).toBeVisible();
    await expect(composer).toHaveValue('Keep this unsent authoring message');
    await expect(composer).toBeFocused();
    await expect(page.getByLabel('Task title', { exact: true })).toBeHidden();
    expect(calls.setupPosts).toHaveLength(1);
    expect(calls.setupPosts[0]).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra', apiKey: secret, maxUsd: '0.125000' });
    expect(calls.turns).toHaveLength(0);
    await noSecretInBrowser(page, secret);
    const afterSave = await openConfigure(page), reopenedKey = afterSave.getByLabel('API key', { exact: true });
    await expect(reopenedKey).toHaveValue('');
    const reopenedSecret = 'synthetic-ui-reopen-key';
    await reopenedKey.fill(reopenedSecret);
    await page.keyboard.press('Escape');
    await expect(afterSave).toBeHidden();
    await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
    await noSecretInBrowser(page, reopenedSecret);
    const cancelled = await openConfigure(page), cancelKey = cancelled.getByLabel('API key', { exact: true });
    await expect(cancelKey).toHaveValue('');
    const reopenCancelSecret = 'synthetic-ui-reopen-cancel-key';
    await cancelKey.fill(reopenCancelSecret);
    await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(cancelled).toBeHidden();
    await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
    await noSecretInBrowser(page, reopenCancelSecret);
    await page.getByRole('button', { name: 'Back to my task', exact: true }).click();
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved task title');
  });
}

test('failed authoring and setup reads expose safe retries without inferring configuration', async ({ page, demo }) => {
  const { calls } = await scriptSetup(page, {
    onAuthoringRead: reads => reads.authoringReads === 1
      ? { status: 503, body: { message: 'Synthetic status outage' } }
      : null,
    onSetupRead: reads => reads.setupReads === 1
      ? { status: 503, body: { message: 'Synthetic setup read outage' } }
      : null,
  });
  await enterStudio(page, demo.origin);
  const panel = authoring(page), ui = studio(page);
  await expect(panel.getByRole('button', { name: 'Retry status', exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry status', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
  const dialog = await openConfigure(page);
  await expect(dialog.getByRole('alert')).toContainText('Assistant settings could not be checked.');
  const retry = dialog.getByRole('button', { name: 'Retry status', exact: true });
  await expect(retry).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
  await retry.click();
  await expect(dialog.getByLabel('API key', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
  expect(calls.authoringReads).toBeGreaterThanOrEqual(2);
  expect(calls.setupReads).toBe(2);
  expect(calls.setupPosts).toHaveLength(0);
  expect(calls.turns).toHaveLength(0);
});

test('held setup save disables duplicates and a conflict keeps the previous safe projection', async ({ page, demo }) => {
  let release, arrived;
  const posted = new Promise(resolve => { arrived = resolve; });
  const { calls } = await scriptSetup(page, {
    onSetupSave: async route => {
      arrived(); await new Promise(resolve => { release = resolve; });
      return json(route, { message: 'Settings were not saved.' }, 409);
    },
  });
  await enterStudio(page, demo.origin);
  const dialog = await openConfigure(page);
  await dialog.getByLabel('API key', { exact: true }).fill('synthetic-ui-conflict-key');
  await dialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('0.5');
  const save = dialog.getByRole('button', { name: 'Save settings', exact: true });
  await save.click(); await posted;
  await expect(dialog.getByRole('button', { name: 'Saving settings…', exact: true })).toBeDisabled();
  expect(await dialog.getByLabel('API key', { exact: true }).inputValue()).toBe('');
  expect(calls.setupPosts).toHaveLength(1);
  release();
  await expect(dialog.getByRole('alert')).toContainText('Settings were not saved.');
  await expect(dialog).toContainText('Current settings: Not configured.');
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByLabel('API key', { exact: true })).toBeFocused();
  expect(calls.setupPosts).toHaveLength(1);
  expect(calls.turns).toHaveLength(0);
  await noSecretInBrowser(page, 'synthetic-ui-conflict-key');
});

test('a lost successful setup response is read back but preserves uncertainty without a retry', async ({ page, demo }) => {
  const { calls, state } = await scriptSetup(page, {
    onSetupSave: async (route, body, _calls, mutable) => {
      mutable.projection = setupDto(body);
      mutable.availability = mutable.projection.availability;
      return route.abort('failed');
    },
  });
  await enterStudio(page, demo.origin);
  const dialog = await openConfigure(page), secret = 'synthetic-ui-lost-response-key';
  await dialog.getByLabel('API key', { exact: true }).fill(secret);
  await dialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('0.25');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('A matching status cannot confirm whether the key was replaced.');
  await expect(dialog).toContainText('Current settings: openai / gpt-5.6-terra · 0.25 USD total.');
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('');
  expect(state.projection.configuration.source).toBe('local');
  expect(calls.setupReads).toBeGreaterThanOrEqual(2);
  expect(calls.setupPosts).toHaveLength(1);
  expect(calls.turns).toHaveLength(0);
  await noSecretInBrowser(page, secret);
});

test('an owner switch fences a pending setup response and clears the old key from the new workspace', async ({ page, context, demo }) => {
  let release, arrived;
  const posted = new Promise(resolve => { arrived = resolve; });
  const { calls } = await scriptSetup(page, {
    onSetupSave: async (route, body, _calls, state) => {
      state.projection = setupDto(body); state.availability = state.projection.availability;
      arrived(); await new Promise(resolve => { release = resolve; });
      try { await json(route, state.projection); } catch { /* Owner switch may abort the old component request. */ }
    },
  });
  await enterStudio(page, demo.origin);
  const ui = studio(page), dialog = await openConfigure(page), secret = 'synthetic-ui-owner-switch-key';
  await dialog.getByLabel('API key', { exact: true }).fill(secret);
  await dialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('0.75');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await posted;

  const other = await context.newPage();
  try {
    await other.goto(demo.origin);
    await other.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('button', { name: /^Continue as Leo/ })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    release();
    await other.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
    await other.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await expect(studio(other)).toBeVisible();
    await page.getByRole('button', { name: /^Continue as Leo/ }).click();
    await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await expect(authoring(page)).toBeVisible();
    await expect(ui.getByText('Advice for Leo', { exact: true })).toBeVisible();
    await expect(ui.getByLabel('API key', { exact: true })).toHaveCount(0);
    await noSecretInBrowser(page, secret);
    expect(calls.setupPosts).toHaveLength(1);
    expect(calls.turns).toHaveLength(0);
  } finally { release?.(); await other.close(); }
});
