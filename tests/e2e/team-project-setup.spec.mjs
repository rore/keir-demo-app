import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { navigate, switchPerson, openWorkspaceTool } from '../fixtures/workspace-ui.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { taskService } from '../../src/data.mjs';
const scope = page => page.getByLabel('Personal or Team project', { exact: true });

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
  await expect(dialog.getByLabel('Teammate', { exact: true })).toBeVisible();
  await dialog.getByLabel('Teammate', { exact: true }).selectOption('leo');
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

test('focused New project does not resubmit after the save reply is lost', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const form = page.getByRole('main', { name: 'New project' });
    const name = form.getByLabel('New project name');
    let writes = 0;
    await page.route('**/api/projects', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++;
      const saved = await route.fetch();
      expect(saved.status()).toBe(201);
      await route.abort();
    });
    await name.fill('Saved without a reply');
    await form.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Reload Tasks to check your projects');
    await expect(form.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
    await name.evaluate(node => node.form.requestSubmit());
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
    expect(writes).toBe(1);
    expect(taskService(fixture.db).listProjects('maya').filter(project => project.name === 'Saved without a reply')).toHaveLength(1);
    expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`focused New project preserves scrolled filtered Tasks at ${viewport.width}px`, async ({ browser }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const touch = viewport.width === 390;
    const context = await browser.newContext({ viewport, hasTouch: touch });
    const page = await context.newPage();
    let release;
    try {
      const service = taskService(fixture.db), personal = { id: fixture.metadata.projectId, name: fixture.metadata.projectName };
      const team = service.createProject('maya', { name: 'Existing Team', mode: 'TEAM' });
      const start = touch ? team : personal, mode = touch ? 'PERSONAL' : 'TEAM';
      for (let i = 1; i <= 30; i++) await service.createTask('maya', {
        projectId: start.id, title: `Anchor task ${i}`, tags: ['keep'],
      }, { operationId: randomUUID() });
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      await tasksProject(page, start);
      const old = page.locator('main.task-main[aria-labelledby="tasks-heading"]');
      const heading = old.getByRole('heading', { name: start.name, exact: true });
      const quickAdd = old.getByLabel('New task title');
      await expect(heading).toBeVisible();
      await quickAdd.fill('Unsent task');
      await old.getByRole('searchbox', { name: 'Search tasks' }).fill('Anchor');
      await old.locator('.task-filter > summary').click();
      await old.getByLabel('Filter by tag').fill('keep');
      await old.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(old.getByRole('heading', { name: 'Search results' })).toBeVisible();
      await expect(old.getByText('Tagged “keep”')).toBeVisible();
      await expect(old.getByRole('button', { name: 'Anchor task 1', exact: true })).toBeAttached();
      const launch = old.getByRole('button', { name: 'New project', exact: true });
      // The narrow project picker is not sticky. Scroll while keeping its launcher in view.
      const y = touch ? 28 : 280;
      await old.evaluate((node, y) => { node.scrollTop = y; }, y);
      await expect.poll(() => old.evaluate(node => node.scrollTop)).toBe(y);
      await expect(launch).toBeInViewport({ ratio: 1 });
      const invoke = async () => {
        if (touch) await launch.tap();
        else { await launch.evaluate(node => node.focus({ preventScroll: true })); await page.keyboard.press('Enter'); }
      };
      await invoke();
      const form = page.getByRole('main', { name: 'New project' });
      const name = form.getByLabel('New project name');
      const type = form.getByLabel('Who is this for?');
      const save = form.getByRole('button', { name: 'Save project', exact: true });
      const cancel = form.getByRole('button', { name: 'Cancel', exact: true });
      await expect(name).toBeFocused();
      await expect(form).toBeVisible();
      await expect(old).toBeHidden();
      for (const control of [name, type, save, cancel]) await expect(control).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await quickAdd.evaluate(node => node.focus());
      await expect(name).toBeFocused();
      await page.keyboard.press('Tab'); await expect(type).toBeFocused();
      await page.keyboard.press('Tab'); await expect(save).toBeFocused();
      await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
      await type.selectOption(touch ? 'PERSONAL' : 'TEAM');
      await name.fill('Discard this project');
      await page.screenshot({ path: info.outputPath('focused-new-project.png') });
      if (touch) await cancel.tap();
      else { await cancel.focus(); await page.keyboard.press('Enter'); }
      await expect(launch).toBeFocused();
      await expect(launch).toBeInViewport({ ratio: 1 });
      await expect(heading).toBeVisible();
      await expect.poll(() => old.evaluate(node => node.scrollTop)).toBe(y);
      await expect(old.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('Anchor');
      await expect(old.getByText('Tagged “keep”')).toBeVisible();
      await expect(quickAdd).toHaveValue('Unsent task');
      expect(service.listProjects('maya').some(project => project.name === 'Discard this project')).toBe(false);

      await invoke();
      await expect(type).toHaveValue('PERSONAL');
      await type.selectOption(mode);
      await name.fill('   ');
      await save.click();
      await expect(form.getByRole('alert')).toContainText('Project name');
      await expect(name).toHaveValue('   ');
      await expect(type).toHaveValue(mode);
      const projectName = mode === 'TEAM' ? 'New Team from Personal' : 'New Personal from Team';
      await name.fill(projectName);
      let count = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') count++;
      });
      const pending = await hold(page, '**/api/projects');
      release = pending.release;
      await save.click();
      await pending.started;
      await expect(cancel).toBeDisabled();
      await expect(form.getByRole('button', { name: 'Saving project…' })).toBeDisabled();
      await name.evaluate(node => { node.form.requestSubmit(); node.form.requestSubmit(); });
      release();
      await expect(old.getByRole('heading', { name: projectName, exact: true })).toBeFocused();
      await expect(old.getByLabel('New task title')).toHaveValue('');
      await expect(old.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('');
      await expect(form).toHaveCount(0);
      expect(count).toBe(1);
      const saved = service.listProjects('maya').filter(project => project.name === projectName);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ mode, ...(mode === 'TEAM' && { role: 'ADMIN' }) });
      expect(fixture.requests).toEqual([]);
    } finally { release?.(); await context.close(); await fixture.close(); }
  });

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
      const personalId = await scope(page).inputValue();
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
      await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeEnabled();
      await expect(page.getByRole('region', { name: 'Team customization access', exact: true })).toContainText('everyone’s new tasks');
      await expect(page.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('team-scoped-entry.png') });
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Customization Studio', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      teamActive = false;
      await scope(page).selectOption(personalId);
      await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeVisible();
      await page.goBack();
      teamActive = true;
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(scope(page)).toHaveValue(team.id);
      teamActive = false;
      await scope(page).selectOption(personalId);
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
      await expect(page.getByRole('button', { name: /^(Open Studio|New customization)$/ })).toHaveCount(0);
      const access = page.getByRole('region', { name: 'Team customization access', exact: true });
      await expect(access).toContainText('Only project admins');
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
      await scope(page).selectOption(a.id);
      collection.release();
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Team customization access' })).toContainText('Team A');
      await navigate(page, 'Tasks');
      const tasks = await hold(page, `**/api/projects/${personal.id}/tasks`);
      await tasksProject(page, personal); await tasks.started;
      await tasksProject(page, b); tasks.release();
      await expect(page.getByRole('heading', { name: b.name, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Gather material references', exact: true })).toHaveCount(0);
      await tasksProject(page, a);
      const members = await hold(page, `**/api/projects/${a.id}/members`);
      await navigate(page, 'Customizations'); await members.started;
      await scope(page).selectOption(b.id);
      members.release();
      const access = page.getByRole('region', { name: 'Team customization access', exact: true });
      await expect(access.getByRole('status')).toContainText('Team B');
      await expect(access.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      await scope(page).selectOption(a.id);
      const person = await hold(page, `**/api/projects/${a.id}/members`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await person.started;
      await switchPerson(page, 'sam'); person.release();
      await expect(page.getByRole('heading', { name: 'A quieter workspace', exact: true })).toBeVisible();
      await expect(page.getByText('Leo · Member', { exact: true })).toHaveCount(0);
      expect(fixture.requests).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}
