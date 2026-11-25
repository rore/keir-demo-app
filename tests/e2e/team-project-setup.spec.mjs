import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { navigate, switchPerson, openWorkspaceTool } from '../fixtures/workspace-ui.mjs';
import { teamProjectService } from '../../src/team-native.mjs';

async function createTeam(page, name) {
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByLabel('Who is this for?', { exact: true })).toHaveValue('PERSONAL');
  await page.getByLabel('Who is this for?', { exact: true }).selectOption('TEAM');
  await page.getByLabel('New project name', { exact: true }).fill(name);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  const project = await result.json();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return project;
}
async function tasksProject(page, project) {
  const select = page.getByRole('combobox', { name: 'Project', exact: true });
  const button = page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('button', { name: project.name, exact: true });
  await expect(select.or(button)).toBeVisible();
  if (await select.isVisible()) await select.selectOption(project.id);
  else await button.click();
}
async function addLeo(page, name) {
  const tools = await openWorkspaceTool(page, '.project-tools');
  await tools.getByRole('button', { name: 'Manage members', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${name} · Team`, exact: true });
  await expect(dialog.getByLabel('Existing demo person', { exact: true })).toBeVisible();
  await dialog.getByLabel('Existing demo person', { exact: true }).selectOption('leo');
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(dialog.getByText('Leo · Member', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-tools > summary')).toBeFocused();
}
async function hold(page, pattern) {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response }).catch(() => {}); // Navigation may already have aborted this request.
  }, { times: 1 });
  return { started, release };
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`ordinary Team setup, Personal draft, Back and current membership at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    let teamActive = false;
    const forbidden = [];
    page.on('request', request => {
      if (teamActive && /^\/api\/(extensions|authoring)(\/|\?|$)/.test(new URL(request.url()).pathname)) forbidden.push(request.url());
    });
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      await navigate(page, 'Customizations');
      const personalId = await page.getByLabel('Customization scope', { exact: true }).inputValue();
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      const composer = page.getByLabel('Message to Daymark assistant', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep this unsent Personal draft separate.');
      const team = await createTeam(page, 'Launch team');
      teamActive = true;
      await addLeo(page, team.name);
      expect(fixture.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(team.id).revision_id).toBeNull();
      await navigate(page, 'Customizations');
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open Studio', exact: true })).toBeEnabled();
      await expect(page.getByRole('region', { name: 'Team customization access', exact: true })).toContainText('everyone’s new tasks');
      await expect(page.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('team-scoped-entry.png') });
      await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Customization Studio', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      teamActive = false;
      await page.getByLabel('Customization scope', { exact: true }).selectOption(personalId);
      await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeVisible();
      await page.goBack();
      teamActive = true;
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(page.getByLabel('Customization scope', { exact: true })).toHaveValue(team.id);
      teamActive = false;
      await page.getByLabel('Customization scope', { exact: true }).selectOption(personalId);
      await page.getByRole('button', { name: 'Return to Personal Studio', exact: true }).click();
      await expect(composer).toHaveValue('Keep this unsent Personal draft separate.');
      await navigate(page, 'Tasks');
      await tasksProject(page, team);
      teamActive = true;
      await switchPerson(page, 'leo');
      await expect(page.getByRole('heading', { name: team.name, exact: true })).toBeVisible();
      await expect(page.getByText('Team project', { exact: true })).toBeVisible();
      await expect(page.getByText('Member', { exact: true })).toHaveCount(0);
      await page.getByLabel('New task title', { exact: true }).fill('Member native work');
      await page.locator('.quick-add').getByRole('button', { name: /Add task/ }).click();
      await expect(page.getByRole('button', { name: 'Member native work', exact: true })).toBeVisible();
      await tasksProject(page, team);
      await expect(page.getByRole('button', { name: 'Member native work', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Complete Member native work', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Member native work, completed', exact: true })).toBeDisabled();
      await navigate(page, 'Customizations');
      await expect(page.getByRole('button', { name: 'Open Studio', exact: true })).toBeDisabled();
      const access = page.getByRole('region', { name: 'Team customization access', exact: true });
      await expect(access).toContainText('Only a project admin');
      teamProjectService(fixture.db).removeMember('maya', team.id, 'leo');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(access.getByRole('alert')).toContainText('could not be accessed');
      await expect(page.getByRole('button', { name: 'New customization', exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('team-access-removed.png') });
      expect(forbidden).toEqual([]);
      expect(fixture.requests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await fixture.close(); }
  });

  test(`late collection, task and member responses cannot cross scope at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      const personal = { id: fixture.metadata.projectId, name: fixture.metadata.projectName };
      const a = await createTeam(page, 'Team A'), b = await createTeam(page, 'Team B');
      await tasksProject(page, a); await addLeo(page, a.name);
      await tasksProject(page, personal);
      const collection = await hold(page, '**/api/extensions');
      await navigate(page, 'Customizations'); await collection.started;
      await page.getByLabel('Customization scope', { exact: true }).selectOption(a.id);
      collection.release();
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New customization', exact: true })).toHaveCount(0);
      await navigate(page, 'Tasks');
      const tasks = await hold(page, `**/api/projects/${personal.id}/tasks`);
      await tasksProject(page, personal); await tasks.started;
      await tasksProject(page, b); tasks.release();
      await expect(page.getByRole('heading', { name: b.name, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Gather material references', exact: true })).toHaveCount(0);
      await tasksProject(page, a);
      const members = await hold(page, `**/api/projects/${a.id}/members`);
      await navigate(page, 'Customizations'); await members.started;
      await page.getByLabel('Customization scope', { exact: true }).selectOption(b.id);
      members.release();
      const access = page.getByRole('region', { name: 'Team customization access', exact: true });
      await expect(access.getByRole('status')).toContainText('Team B');
      await expect(access.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      await page.getByLabel('Customization scope', { exact: true }).selectOption(a.id);
      const person = await hold(page, `**/api/projects/${a.id}/members`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await person.started;
      await switchPerson(page, 'sam'); person.release();
      await expect(page.getByRole('heading', { name: 'A quieter workspace', exact: true })).toBeVisible();
      await expect(page.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      expect(fixture.requests).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}
