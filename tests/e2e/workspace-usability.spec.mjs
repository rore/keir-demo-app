import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { navigate, switchPerson, openWorkspaceTool } from '../fixtures/workspace-ui.mjs';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 626, height: 500 },
  { width: 390, height: 844 }, { width: 390, height: 500 }, { width: 683, height: 384 }]) {
  test(`Tasks page scrolls and retains position at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i++) fixture.db.prepare(
      'INSERT INTO tasks (id,owner_id,project_id,title,notes,status,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(`scroll-${i}`, 'maya', fixture.metadata.projectId, `Review item ${i}`, '', i < 40 ? 'open' : 'completed', now, now, i < 40 ? null : now);
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      const content = page.getByRole('region', { name: 'Task list', exact: true });
      await expect(content).toBeVisible();
      const main = page.locator('.task-main'), header = page.locator('.workspace-top'), quickAdd = page.locator('.quick-add');
      const [shell, pageBox, add] = await Promise.all([header.boundingBox(), main.boundingBox(), quickAdd.boundingBox()]);
      await page.mouse.move(pageBox.x + pageBox.width - 30, pageBox.y + pageBox.height / 2);
      await page.mouse.wheel(0, 650);
      await expect.poll(() => main.evaluate(node => node.scrollTop)).toBeGreaterThan(200);
      expect(await header.boundingBox()).toEqual(shell);
      expect((await quickAdd.boundingBox()).y).toBeLessThan(add.y - 200);
      expect(await content.evaluate(node => node.scrollTop)).toBe(0);
      const position = await main.evaluate(node => node.scrollTop);
      await navigate(page, 'Customizations');
      await navigate(page, 'Tasks');
      expect(await main.evaluate(node => node.scrollTop)).toBe(position);
      await page.getByLabel('Search tasks', { exact: true }).fill('Review item');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Search results', exact: true })).toBeAttached();
      await expect(content.getByRole('button', { name: 'Review item 0', exact: true })).toBeAttached();
      await main.focus(); await page.keyboard.press('Home');
      await page.screenshot({ path: info.outputPath('task-content-scroll.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      const first = content.getByRole('button', { name: 'Review item 0', exact: true });
      await first.click();
      await expect(page.getByRole('dialog', { name: 'Task details', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(first).toBeFocused();
    } finally { await page.close(); await fixture.close(); }
  });
}

test('direct account choices switch people and choosing the current person keeps input without reauthentication', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByLabel('New task title', { exact: true }).fill('Keep my unsaved title');
    const auth = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/session' && request.method() !== 'GET') auth.push(request.method()); });
    await openWorkspaceTool(page, '.user-tools');
    await expect(page.locator('.user-tools select')).toHaveCount(0);
    await page.locator('.person-choices button[value="maya"]').press('Enter');
    await expect(page.locator('.user-tools > summary')).toBeFocused();
    await expect(page.getByLabel('New task title', { exact: true })).toHaveValue('Keep my unsaved title');
    expect(auth).toEqual([]);
    await switchPerson(page, 'leo');
    await expect(page.locator('.person-choices button[aria-pressed="true"]')).toHaveAttribute('value', 'leo');
    await expect(page.getByLabel('New task title', { exact: true })).toHaveValue('');
    expect(auth).toEqual(['POST']);
    await openWorkspaceTool(page, '.user-tools');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Continue as Maya/ })).toBeVisible();
  } finally { await page.close(); await fixture.close(); }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 683, height: 384 },
  { width: 390, height: 844 }, { width: 390, height: 500 }]) {
  test(`project tool popup opens in view without moving fixed controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const now = new Date().toISOString();
    for (let i = 0; i < 40; i++) fixture.db.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(`menu-project-${i}`, 'maya', `Additional project ${i}`, now, now);
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      await expect(page.getByLabel('New task title', { exact: true })).toBeVisible();
      const bounds = () => page.evaluate(() => ['.task-page-heading', '.task-projects', '.quick-add', '.task-search-form']
        .map(selector => document.querySelector(selector).getBoundingClientRect().toJSON()));
      const before = await bounds();
      const newProject = page.getByRole('button', { name: 'New project', exact: true });
      await expect(newProject).toBeInViewport({ ratio: 1 });
      expect(await newProject.evaluate(node => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      const menu = await openWorkspaceTool(page, '.project-tools');
      const rename = menu.getByRole('button', { name: 'Rename project', exact: true });
      await expect(rename).toBeInViewport({ ratio: 1 });
      expect(await rename.evaluate(node => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      expect(await bounds()).toEqual(before);
      expect(await page.locator('.task-main').evaluate(node => node.scrollTop)).toBe(0);
      await rename.focus();
      await page.keyboard.press('Escape');
      await expect(menu.locator(':scope > summary')).toBeFocused();
      await newProject.click();
      await expect(page.getByLabel('New project name', { exact: true })).toBeFocused();
      await page.locator('.project-form').getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(newProject).toBeFocused();
      await openWorkspaceTool(page, '.project-tools');
      await menu.getByRole('button', { name: 'Rename project', exact: true }).click();
      await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(fixture.metadata.projectName);
      await page.locator('.project-form').getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(menu.locator(':scope > summary')).toBeFocused();
      expect(await bounds()).toEqual(before);
    } finally { await page.close(); await fixture.close(); }
  });
}
