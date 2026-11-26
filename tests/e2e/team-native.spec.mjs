import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { switchPerson } from '../fixtures/workspace-ui.mjs';
import { compileTeamFixture, seedTeamFixture } from '../../scripts/team-native-fixture.mjs';
import { teamProjectService } from '../../src/team-native.mjs';

let compiled;
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`seeded native Team journey uses existing task screens at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const assets = await (compiled ??= compileTeamFixture());
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const project = seedTeamFixture(fixture.db, assets);
    async function selectTeam() {
      const select = page.getByRole('combobox', { name: 'Project', exact: true });
      const button = page.getByRole('navigation', { name: 'Projects', exact: true })
        .getByRole('button', { name: 'Shared collection', exact: true });
      await expect(select.or(button)).toBeVisible();
      if (await select.isVisible()) await select.selectOption(project);
      else await button.click();
      await expect(page.getByText('Team project', { exact: true })).toBeVisible();
    }
    async function create(title) {
      await page.getByLabel('New task title', { exact: true }).fill(title);
      await page.locator('.quick-add').getByRole('button', { name: /Add task/ }).click();
      await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    }
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      await selectTeam();
      await create('A shared deliverable');
      await page.getByRole('button', { name: 'Complete A shared deliverable', exact: true }).click();
      await page.getByRole('button', { name: 'A shared deliverable', exact: true }).click();
      const hold = page.getByRole('region', { name: 'Last completion attempt', exact: true });
      await expect(hold).toContainText('Complete the linked review first.');
      await expect(page.getByRole('button', { name: 'Open task: Review deliverable', exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('team-denied.png') });
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await switchPerson(page, 'leo');
      await selectTeam();
      const review = page.locator('.task-row').filter({ has: page.getByRole('button', { name: 'Review deliverable', exact: true }) });
      await expect(review).toContainText('Assigned to Leo');
      await review.getByRole('button', { name: 'Complete Review deliverable', exact: true }).click();
      await expect(review.getByRole('button', { name: 'Review deliverable, completed', exact: true })).toBeDisabled();
      await page.screenshot({ path: info.outputPath('team-leo-completed.png') });
      teamProjectService(fixture.db).setSelection('maya', project, 'review-v2');
      await switchPerson(page, 'maya');
      await selectTeam();
      await page.getByRole('button', { name: 'Complete A shared deliverable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'A shared deliverable, completed', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'A shared deliverable', exact: true }).click();
      const completedDetail = page.getByRole('dialog', { name: 'Task details', exact: true });
      await expect(completedDetail.getByRole('region', { name: 'Task creation customization outcome', exact: true })).toHaveCount(1);
      await expect(completedDetail.getByRole('region', { name: 'Customization outcome', exact: true })).toHaveCount(0);
      await expect(completedDetail.getByRole('button', { name: 'Open task: Review deliverable', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await create('New revision deliverable');
      await page.getByRole('button', { name: 'New revision deliverable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open task: Check the revised deliverable', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await expect(page.locator('.task-row').filter({ has: page.getByRole('button', { name: 'Check the revised deliverable', exact: true }) }))
        .toContainText('Assigned to Maya');
      await page.screenshot({ path: info.outputPath('team-version-switch.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      expect(fixture.requests).toEqual([], 'Native Team execution makes no provider request');
    } finally { await page.close(); await fixture.close(); }
  });
}
