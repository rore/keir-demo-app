import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { taskService } from '../../src/data.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function openSaved(page, fixture, name) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const destination = page.getByLabel('Destination', { exact: true });
  await expect.poll(async () => await navigation.isVisible() || await destination.isVisible()).toBe(true);
  if (await navigation.isVisible()) await navigation.getByRole('button', { name: 'Customizations', exact: true }).click();
  else await destination.selectOption('customizations');
  await page.getByRole('article', { name, exact: true }).getByRole('button', { name: /^(Open|Continue changes)$/, exact: true }).click();
  await expect(studio(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`optional rename keeps the full accessible name and compact navigation at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const name = 'Keep unfinished work visible while all completed work stays exactly as it is today'.padEnd(80, '.').slice(0, 80);
    const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name });
    const before = fixture.db.prepare('SELECT * FROM extension_selections WHERE owner_id=? ORDER BY hook_id').all('maya');
    const renameRequests = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/rename$/.test(new URL(request.url()).pathname)) renameRequests.push(request); });
    try {
      await page.setViewportSize(viewport); await openSaved(page, fixture, name);
      const ui = studio(page), rename = ui.getByRole('button', { name: 'Rename', exact: true });
      const heading = ui.getByRole('heading', { name, exact: true });
      await expect(heading).toHaveAttribute('title', name);
      const geometry = await heading.evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) }));
      expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
      await expect(ui.getByRole('button', { name: 'More', exact: true })).toBeInViewport({ ratio: 1 });
      await ui.getByRole('button', { name: 'Back to Customizations', exact: true }).scrollIntoViewIfNeeded();
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
      expect(fixture.db.prepare('SELECT name FROM extensions WHERE id=?').get(extensionId).name).toBe(name);
      await input.dispatchEvent('compositionend');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
      expect(renameRequests).toHaveLength(0);
      await input.press('Escape'); await expect(rename).toBeFocused();
      await expect(heading).toHaveText(name);
      await rename.click(); await input.fill('My task customization'); await input.press('Enter');
      await expect(ui.getByRole('heading', { name: 'My task customization', exact: true })).toBeVisible();
      await expect(rename).toBeFocused(); await expect(form).toHaveCount(0);
      expect(renameRequests).toHaveLength(1);
      expect(fixture.db.prepare('SELECT * FROM extension_selections WHERE owner_id=? ORDER BY hook_id').all('maya')).toEqual(before);
      await page.reload(); await expect(ui.getByRole('heading', { name: 'My task customization', exact: true })).toBeVisible();
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}

test('a stale rename keeps typed text and refreshes the expected name before a fresh save', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const admitted = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Untitled customization' });
  const item = fixture.db.prepare('SELECT id,name FROM extensions WHERE id=?').get(admitted.extensionId);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSaved(page, fixture, item.name);
    const ui = studio(page), name = ui.getByRole('button', { name: 'Rename', exact: true });
    await expect(name).toBeInViewport({ ratio: 1 });
    await name.click();
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
    await expect(ui.getByRole('button', { name: 'Rename', exact: true })).toBeFocused();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('switching owners discards the prior owner rename text and fences its late result', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const admitted = admitTaskDraft(fixture.db, createLifecycle(fixture.db));
  const item = fixture.db.prepare('SELECT id,name FROM extensions WHERE id=?').get(admitted.extensionId);
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
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
    release();
    await expect(page.getByText('Private Maya name', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Rename customization', exact: true })).toHaveCount(0);
    expect(fixture.db.prepare('SELECT name FROM extensions WHERE id=?').get(item.id).name).toBe(item.name);
    expect(fixture.requests).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});

test('saved behavior illustrates task creation and checked examples keep authored order', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { extensionId: id, conversationId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { owner: 'sam' });
    const project = taskService(fixture.db).listProjects('sam')[0];
    const task = taskCustomizationFixture({ projectId: project.id, otherProjectId: 'other-project-example', title: 'Review completed work' });
    await page.goto(fixture.origin); await page.getByRole('button', { name: 'Continue as Sam' }).click();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
    const post = (path, body) => page.evaluate(async ({ path, body }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, { path, body });
    let saved = await post(`extensions/${id}/compile`, { hookId: TASK_HOOK, source: task.source, draftVersion: 0, label: 'Checked task creation' });
    const cases = [...task.cases].sort((a, b) => Number(JSON.parse(a).id === 'matching-project') - Number(JSON.parse(b).id === 'matching-project'));
    saved = await post(`extensions/${id}/scenarios`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases });
    saved = await post(`extensions/${id}/simulate`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
    expect(saved.evidence.passed).toBe(true);
    expect(JSON.parse(cases[0]).id).toBe('other-project');
    const conversation = fixture.db.prepare('SELECT id,state FROM authoring_conversations WHERE id=?').get(conversationId);
    const state = JSON.parse(conversation.state);
    state.handles = { revisionId: saved.draft.id, draftVersion: saved.draftVersion, suiteDigest: saved.draft.suiteDigest };
    fixture.db.prepare('UPDATE authoring_conversations SET state=? WHERE id=?').run(JSON.stringify(state), conversation.id);
    await page.goto(fixture.origin + '/#customization=' + id);
    const ui = studio(page), decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    const invitation = ui.getByRole('button', { name: 'See proposed change', exact: true }).first();
    await openSavedChanges(page);
    await expect(ui.getByRole('article', { name: 'About this rule', exact: true })).toContainText(task.metadata.title);
    const proposed = decision.getByRole('region', { name: 'Checked proposed behavior', exact: true });
    const rows = proposed.getByRole('article', { name: /^Example:/ });
    await expect(rows).toHaveCount(cases.length);
    await expect(rows.first()).toContainText('No change.');
    const example = proposed.getByRole('article', { name: `Example: Task completed in ${project.name}`, exact: true });
    await expect(example).toHaveCount(1);
    await expect(example.locator('dd').nth(2)).toContainText(task.metadata.title);
    await expect(example.getByText('Task created as intended', { exact: true })).toBeVisible();
    const exact = decision.getByLabel('Exact checked examples', { exact: true });
    await expect(exact).toBeHidden();
    await decision.getByText('Technical details for this version', { exact: true }).click();
    await expect(exact).toContainText(saved.evidence.id);
    await decision.getByRole('button', { name: 'Hide simulation', exact: true }).click();
    await expect(invitation).toBeFocused();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
