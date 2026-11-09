import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const composer = page => studio(page).getByLabel('Message to Daymark assistant', { exact: true });
const more = page => studio(page).getByRole('region', { name: 'Versions and settings', exact: true });
const developerTools = page => more(page).locator('details.rs-developer-tools');
async function read(page, path) {
  return page.evaluate(async path => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/' + path, { headers: { 'X-Session-Context': session.contextToken } });
    if (!response.ok) throw new Error('Synthetic read failed: ' + response.status);
    return response.json();
  }, path);
}
async function enter(page, fixture) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
}
async function openItem(page, id) {
  const mobile = page.getByLabel('Destination', { exact: true });
  if (await mobile.isVisible()) await mobile.selectOption('customizations');
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator('#edit-' + id).click();
  await expect(composer(page)).toBeVisible();
}
async function openMore(page) {
  await studio(page).getByRole('button', { name: 'More', exact: true }).click();
  await expect(more(page).getByRole('heading', { name: 'Versions and settings', exact: true })).toBeFocused();
  await expect(developerTools(page)).toHaveJSProperty('open', false);
}
async function openDeveloperTools(page) {
  await developerTools(page).locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(developerTools(page)).toHaveJSProperty('open', true);
  await expect(developerTools(page).getByText('Technical information for setup and troubleshooting.', { exact: true })).toBeVisible();
}
function recordWrites(page) {
  const writes = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url());
  });
  return writes;
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 740 }, { width: 683, height: 384 }]) {
  test(`More separates ordinary versions from explicit developer tools at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture();
    try {
      const lifecycle = createLifecycle(fixture.db);
      const first = admitTaskDraft(fixture.db, lifecycle, { name: 'First More example' }).extensionId;
      const second = admitTaskDraft(fixture.db, lifecycle, { name: 'Second More example' }).extensionId;
      await page.setViewportSize(viewport);
      await enter(page, fixture);
      const writes = recordWrites(page), before = await read(page, `extensions/${first}`);
      const secondBefore = await read(page, `extensions/${second}`);
      const setup = await read(page, 'authoring/setup');
      expect(setup.configuration).toMatchObject({ status: 'ready', provider: 'openai', model: 'gpt-5.6-terra' });
      await openItem(page, first);
      const draft = 'Keep this unsent question while I inspect versions and settings.';
      await composer(page).fill(draft);
      await openMore(page);
      const panel = more(page), tools = developerTools(page);
      const use = panel.getByRole('region', { name: 'What’s in use', exact: true });
      const earlier = panel.getByRole('region', { name: 'Earlier versions', exact: true });
      const currentUse = before.selection.revision ? before.selection.eligible
        ? `“${before.selection.revision.extensionName}” is in use.`
        : 'The saved setup could not be checked. Its use is unverified.' : 'No customization is in use.';
      await expect(use.getByRole('heading', { name: 'What’s in use', exact: true })).toBeVisible();
      await expect(use).toContainText(currentUse);
      await expect(earlier.getByRole('heading', { name: 'Earlier versions', exact: true })).toBeVisible();
      await expect(earlier).toContainText('No earlier versions yet.');
      const restore = panel.getByRole('region', { name: 'Restore an earlier version', exact: true });
      await expect(restore.getByRole('heading', { name: 'Restore an earlier version', exact: true })).toBeVisible();
      await expect(restore.getByLabel('Previously in use', { exact: true })).toBeVisible();
      expect(await restore.evaluate(element => !!element.closest('.rs-developer-tools'))).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel.evaluate(node => {
        const use = node.querySelector('[aria-label="What’s in use"]');
        const earlier = node.querySelector('[aria-label="Earlier versions"]');
        const tools = node.querySelector('.rs-developer-tools');
        return !!(use.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING)
          && !!(earlier.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
      const reload = tools.getByRole('button', { name: 'Reload saved state', exact: true, includeHidden: true });
      await expect(reload).toBeHidden();
      await expect(tools.getByRole('heading', { name: 'Authoring status', exact: true, includeHidden: true })).toBeHidden();
      await tools.locator(':scope > summary').focus();
      await reload.evaluate(element => element.focus());
      await expect(tools.locator(':scope > summary')).toBeFocused();
      await page.keyboard.press('Tab');
      expect(await tools.evaluate(element => element.contains(document.activeElement))).toBe(false);
      for (const value of [setup.configuration.provider, setup.configuration.model]) expect(await panel.innerText()).not.toContain(value);

      await openDeveloperTools(page);
      await expect(tools.getByRole('heading', { name: 'Authoring status', exact: true })).toBeVisible();
      await expect(tools.getByRole('button', { name: 'Check authoring status', exact: true })).toBeVisible();
      await expect(tools.getByText('All versions', { exact: true })).toBeVisible();
      const host = tools.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Published host model and supported hooks' }) });
      await host.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
      await expect(host.getByLabel('Published host hooks', { exact: true })).toBeVisible();
      await expect(host.getByLabel('Published host hooks', { exact: true })).toContainText('TaskCompleted');
      const lookup = tools.locator('details.rs-lookup');
      await lookup.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
      await expect(lookup.getByLabel('Evidence ID for this person', { exact: true })).toBeVisible();
      await reload.click();
      await expect(tools.getByRole('button', { name: 'Reload saved state', exact: true })).toBeEnabled();
      const assistant = tools.getByRole('region', { name: 'Assistant setup', exact: true });
      await expect(assistant.getByRole('heading', { name: 'Assistant setup', exact: true })).toBeVisible();
      for (const value of [setup.configuration.provider, setup.configuration.model]) expect(await panel.innerText()).not.toContain(value);
      const configure = assistant.getByRole('button', { name: 'Configure', exact: true });
      await configure.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Service', { exact: true })).toHaveValue(setup.configuration.provider);
      await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue(setup.configuration.model);
      await expect(dialog).toContainText(`Current settings: ${setup.configuration.provider} / ${setup.configuration.model}`);
      await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(configure).toBeFocused();
      await expect(composer(page)).toHaveValue(draft);
      await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(studio(page).getByRole('button', { name: 'More', exact: true })).toBeFocused();
      await expect(composer(page)).toHaveValue(draft);
      await openMore(page);
      await openDeveloperTools(page);
      await studio(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await openItem(page, second);
      await expect(composer(page)).toHaveValue('');
      await openMore(page);
      await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await studio(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await openItem(page, first);
      await expect(composer(page)).toHaveValue(draft);
      expect(await read(page, `extensions/${first}`)).toEqual(before);
      expect(await read(page, `extensions/${second}`)).toEqual(secondBefore);
      expect(writes).toEqual([]); expect(fixture.requests).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}

test('an unavailable assistant keeps its direct Configure action outside closed developer tools', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const id = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Unconfigured More example' }).extensionId;
    await enter(page, fixture);
    const writes = recordWrites(page), before = await read(page, `extensions/${id}`);
    await openItem(page, id);
    const draft = 'Keep this unsent question while assistant setup is unavailable.';
    await composer(page).fill(draft);
    const configure = studio(page).getByRole('button', { name: 'Configure', exact: true });
    await expect(configure).toBeVisible();
    expect(await configure.evaluate(element => !!element.closest('.rs-developer-tools'))).toBe(false);
    await expect(studio(page).getByText('Set up the assistant to create or change a customization.', { exact: true })).toBeVisible();
    await configure.click();
    const dialog = page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
    await expect(dialog).toContainText('Current settings: Not configured.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden(); await expect(configure).toBeFocused();
    await expect(composer(page)).toHaveValue(draft);
    await openMore(page);
    expect(await read(page, `extensions/${id}`)).toEqual(before);
    expect(writes).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});
