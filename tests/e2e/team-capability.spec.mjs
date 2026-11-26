import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { navigate, openWorkspaceTool, switchPerson } from '../fixtures/workspace-ui.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { createTeamCapability } from '../../src/team-capability.mjs';

async function openStudio(page) {
  await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
  await page.getByText('More', { exact: true }).click();
  await page.getByRole('button', { name: 'Open earlier Team work' }).click();
}
const scope = page => page.getByLabel('Personal or Team project', { exact: true });
const checkExamples = page => page.getByRole('button', { name: 'Check examples', exact: true });
const examples = page => page.getByRole('region', { name: 'Examples', exact: true });

async function setup(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await navigate(page, 'Customizations');
  const personalId = await scope(page).inputValue();
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await page.getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep my Personal text through Team simulation.');
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Who is this for?', { exact: true }).selectOption('TEAM');
  await page.getByLabel('New project name', { exact: true }).fill('Review team');
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const project = await (await created).json();
  await expect(page.getByRole('heading', { name: 'Review team', exact: true })).toBeVisible();
  const members = await openWorkspaceTool(page, '.project-tools');
  await members.getByRole('button', { name: 'Manage members', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Teammate', { exact: true }).selectOption('leo');
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(dialog.getByText('Leo · Member', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  return { project, personalId };
}
async function prepare(fixture, project, mismatch = false) {
  const capability = createTeamCapability(fixture.db);
  try {
    const saved = await capability.propose('maya', project.id, { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Review deliverable', intent: 'Saved compatibility fixture' });
    if (mismatch) {
      saved.examples.find(c => c.id === 'success').actions[2].expect.decision = 'ALLOW';
      await capability.simulate('maya', project.id, { expectedDraftVersion: saved.draftVersion, revisionId: saved.draft.revisionId, cases: saved.examples });
    }
  } finally { await capability.close(); }
}
async function held(page, pattern) {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    entered(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  return { started, release };
}
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`ordinary Team proposal, independent pass/fail, saved reload and Personal continuity at ${viewport.width}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true }), forbidden = [];
    let teamScope = false;
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (teamScope && /^\/api\/(authoring|extensions)(\/|$)/.test(path) || /\/capability\/(approvals|activations|approve|activate|repair)(\/|$)/.test(path)) forbidden.push(path);
    });
    try {
      await page.setViewportSize(viewport);
      const { project, personalId } = await setup(page, fixture.origin); teamScope = true;
      const snapshot = () => ['tasks', 'team_admissions', 'team_selections', 'task_create_operations']
        .map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = snapshot();
      await prepare(fixture, project, true);
      await navigate(page, 'Customizations');
      await openStudio(page);
      const result = examples(page);
      await expect(result.getByRole('heading', { name: 'Some examples did not match' })).toBeVisible();
      await expect(result.getByText('Expected: Completion is allowed.', { exact: true })).toBeVisible();
      await expect(result.getByText(/In the example: The task stays open/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('team-simulation-mismatch.png') });
      expect(snapshot()).toEqual(before);
      const saved = fixture.db.prepare('SELECT * FROM team_evidence ORDER BY rowid DESC LIMIT 1').get();
      expect(saved.passed).toBe(0);
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      teamScope = false;
      await scope(page).selectOption(personalId);
      await page.getByRole('button', { name: 'Return to Personal Studio', exact: true }).click();
      await expect(page.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep my Personal text through Team simulation.');
      await navigate(page, 'Customizations');
      await scope(page).selectOption(project.id); teamScope = true;
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await openStudio(page);
      await expect(result.getByRole('heading', { name: 'Some examples did not match' })).toBeVisible();
      await expect(result.getByRole('article', { name: 'What didn’t match' })).toContainText('Expected: Completion is allowed.');
      await expect(result.locator('pre')).toHaveCount(0);
      await expect(result).not.toContainText(saved.id);
      expect(JSON.parse(saved.cases).find(c => c.id === 'success').actions[2].expect.decision).toBe('ALLOW');
      expect(fixture.db.prepare('SELECT passed FROM team_evidence WHERE id=?').get(saved.id).passed).toBe(0);
      expect(fixture.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(project.id).revision_id).toBeNull();
      expect(forbidden).toEqual([]); expect(fixture.requests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await fixture.close(); }
  });

  test(`late evidence, member loss and unconfirmed simulation reply at ${viewport.width}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      const { project } = await setup(page, fixture.origin);
      await prepare(fixture, project);
      await navigate(page, 'Customizations');
      await openStudio(page);
      await expect(page.getByText('Support diagnostics', { exact: true })).toHaveCount(0);
      let posts = 0;
      page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/capability/simulations')) posts++; });
      await page.route(`**/api/projects/${project.id}/capability/simulations`, async route => {
        await route.fetch(); await route.abort('failed');
      }, { times: 1 });
      await checkExamples(page).click();
      await expect(page.getByText('The reply was not confirmed.', { exact: false })).toBeVisible();
      await expect(checkExamples(page)).toBeDisabled();
      await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
      await expect(examples(page).getByRole('heading', { name: 'Examples matched' })).toBeVisible();
      expect(posts).toBe(1);
      await page.getByRole('button', { name: 'I checked saved state', exact: true }).click();
      const evidence = await held(page, `**/api/projects/${project.id}/capability/evidence/*`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await evidence.started;
      await switchPerson(page, 'leo'); evidence.release();
      await navigate(page, 'Customizations');
      await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Open Studio|New customization)$/ })).toHaveCount(0);
      await expect(examples(page)).toHaveCount(0);
      await switchPerson(page, 'maya');
      await navigate(page, 'Customizations');
      await openStudio(page);
      await expect(examples(page)).toBeVisible();
      fixture.db.prepare("UPDATE project_members SET role='MEMBER' WHERE project_id=? AND user_id='maya'").run(project.id);
      const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project.id}/authoring`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      expect((await denied).status()).toBe(403);
      await expect(page.getByRole('alert')).toContainText('Only a project admin can change this.');
      await expect(examples(page)).toHaveCount(0);
      await expect(checkExamples(page)).toHaveCount(0);
      teamProjectService(fixture.db).members('leo', project.id);
      expect(posts).toBe(1); expect(fixture.requests).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}
