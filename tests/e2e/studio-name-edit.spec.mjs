import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function openSaved(page, fixture, name) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const destination = page.getByLabel('Destination', { exact: true });
  await expect.poll(async () => await navigation.isVisible() || await destination.isVisible()).toBe(true);
  if (await navigation.isVisible()) await navigation.getByRole('button', { name: 'Customizations', exact: true }).click();
  else await destination.selectOption('customizations');
  await page.getByRole('article', { name, exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(studio(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`optional rename keeps the full accessible name and compact navigation at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const name = 'Keep unfinished work visible while all completed work stays exactly as it is today'.padEnd(80, '.').slice(0, 80);
    fixture.db.prepare('UPDATE extensions SET name=? WHERE owner_id=?').run(name, 'maya');
    const before = fixture.db.prepare('SELECT * FROM extension_selections WHERE owner_id=?').get('maya');
    const renameRequests = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/rename$/.test(new URL(request.url()).pathname)) renameRequests.push(request); });
    try {
      await page.setViewportSize(viewport); await openSaved(page, fixture, name);
      const ui = studio(page), rename = ui.getByRole('button', { name: 'Rename', exact: true });
      const heading = ui.getByRole('heading', { name, exact: true });
      await expect(heading).toHaveAttribute('title', name);
      const geometry = await heading.evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) }));
      expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
      await expect(ui.getByRole('button', { name: 'History and details', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(ui.getByRole('button', { name: 'Back to Customizations', exact: true })).toBeInViewport({ ratio: 1 });
      await rename.click();
      const form = ui.getByRole('form', { name: 'Rename customization', exact: true }), input = form.getByLabel('Name', { exact: true });
      await expect(input).toBeFocused(); await expect(input).toHaveValue(name);
      await expect(input).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
      mkdirSync('build/studio-real-ai', { recursive: true });
      await page.screenshot({ path: `build/studio-real-ai/rename-${viewport.width}x${viewport.height}.png` });
      await input.fill('Unsent name'); await input.dispatchEvent('compositionstart'); await input.press('Enter');
      await expect(form).toBeVisible(); expect(renameRequests).toHaveLength(0);
      expect(fixture.db.prepare('SELECT name FROM extensions WHERE owner_id=?').get('maya').name).toBe(name);
      await input.dispatchEvent('compositionend');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
      expect(renameRequests).toHaveLength(0);
      await input.press('Escape'); await expect(rename).toBeFocused();
      await expect(heading).toHaveText(name);
      await rename.click(); await input.fill('My task advice'); await input.press('Enter');
      await expect(ui.getByRole('heading', { name: 'My task advice', exact: true })).toBeVisible();
      await expect(rename).toBeFocused(); await expect(form).toHaveCount(0);
      expect(renameRequests).toHaveLength(1);
      expect(fixture.db.prepare('SELECT * FROM extension_selections WHERE owner_id=?').get('maya')).toEqual(before);
      await page.reload(); await expect(ui.getByRole('heading', { name: 'My task advice', exact: true })).toBeVisible();
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}

test('a stale rename keeps typed text and refreshes the expected name before a fresh save', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const item = fixture.db.prepare('SELECT id,name FROM extensions WHERE owner_id=?').get('maya');
  try {
    await openSaved(page, fixture, item.name);
    const ui = studio(page); await ui.getByRole('button', { name: 'Rename', exact: true }).click();
    const form = ui.getByRole('form', { name: 'Rename customization', exact: true }), input = form.getByLabel('Name', { exact: true });
    await input.fill('My preferred name');
    fixture.db.prepare('UPDATE extensions SET name=? WHERE id=?').run('Changed in another view', item.id);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Your text is kept');
    await expect(form.getByRole('alert')).toContainText('The saved name is now “Changed in another view”');
    await expect(input).toHaveValue('My preferred name');
    await expect(ui.getByRole('heading', { name: 'Changed in another view', exact: true })).toBeVisible();
    await input.press('Enter');
    await expect(ui.getByRole('heading', { name: 'My preferred name', exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('switching owners discards the prior owner rename text and fences its late result', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const item = fixture.db.prepare('SELECT id,name FROM extensions WHERE owner_id=?').get('maya');
  let release, started;
  const pending = new Promise(resolve => { release = resolve; }), requestStarted = new Promise(resolve => { started = resolve; });
  try {
    await openSaved(page, fixture, item.name);
    await page.route('**/api/extensions/*/rename', async route => { started(); await pending; await route.continue().catch(() => {}); });
    const ui = studio(page); await ui.getByRole('button', { name: 'Rename', exact: true }).click();
    await ui.getByLabel('Name', { exact: true }).fill('Private Maya name');
    await ui.getByRole('form', { name: 'Rename customization', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
    await requestStarted;
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam');
    release();
    await expect(page.getByText('Private Maya name', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Rename customization', exact: true })).toHaveCount(0);
    expect(fixture.db.prepare('SELECT name FROM extensions WHERE id=?').get(item.id).name).toBe(item.name);
    expect(fixture.requests).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});

test('unfinished advice remains the primary exact example when completed cases were authored first', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin); await page.getByRole('button', { name: 'Continue as Sam' }).click();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
    const post = (path, body) => page.evaluate(async ({ path, body }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, { path, body });
    let saved = await post('extensions', { operationId: crypto.randomUUID(), source: fixture.metadata.source, label: 'Checked advice' });
    const id = saved.extension.id;
    const cases = [...fixture.metadata.cases].sort((a, b) => Number(JSON.parse(b).id === 'synthetic-completed') - Number(JSON.parse(a).id === 'synthetic-completed'));
    saved = await post(`extensions/${id}/scenarios`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases });
    saved = await post(`extensions/${id}/simulate`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
    expect(saved.evidence.passed).toBe(true);
    await page.goto(fixture.origin + '/#customization=' + id);
    const ui = studio(page), decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    const invitation = decision.getByRole('button', { name: 'Show the unfinished task example', exact: true });
    await invitation.click();
    await expect(ui.getByRole('heading', { name: 'What an unfinished task would show', exact: true })).toBeVisible();
    await expect(ui.locator('.rs-example')).toHaveCount(1);
    await expect(ui.locator('.rs-example').getByText('Pending', { exact: true })).toHaveCount(2);
    await expect(ui.locator('.rs-example-details')).toHaveJSProperty('open', false);
    await ui.locator('.rs-example-details > summary').click();
    await expect(ui.getByLabel('Saved synthetic simulation report', { exact: true })).toContainText(saved.evidence.id);
    await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(invitation).toBeFocused();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
