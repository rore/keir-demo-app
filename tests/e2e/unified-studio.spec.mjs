import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { linkedProposal } from '../fixtures/team-authored.mjs';
import { navigate, switchPerson } from '../fixtures/workspace-ui.mjs';
import { taskService } from '../../src/data.mjs';
import { teamProjectService } from '../../src/team-native.mjs';

for (const width of [1440, 390]) test(`one Team conversation to linked task at ${width}px`, async ({ page }, info) => {
  const reply = (name, args) => ({ calls: [{ id: name, name, arguments: args }], text: '', usage: { inputTokens: 1, outputTokens: 1 } });
  const fixture = await startAuthoringFixture({ authoringOverride: { providerFactory: config => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    complete: async request => {
      if (request.tools[0].name === 'resolve_intent') return reply('resolve_intent', { intent: 'prepare', question: '' });
      if (!request.toolResult) return reply('discover_catalog', {});
      const { result } = JSON.parse(request.toolResult.output);
      expect(result.businessContext.members.map(p => p.id).sort()).toEqual(['leo', 'maya']);
      return reply('offer_proposal', { proposalJson: JSON.stringify(linkedProposal()) });
    },
  }) } });
  const project = taskService(fixture.db).createProject('maya', { name: 'Launch team', mode: 'TEAM' });
  teamProjectService(fixture.db).addMember('maya', project.id, { userId: 'leo' });
  async function selectTeam() {
    const select = page.getByRole('combobox', { name: 'Project', exact: true });
    const button = page.getByRole('navigation', { name: 'Projects', exact: true })
      .getByRole('button', { name: project.name, exact: true });
    await expect(select.or(button)).toBeVisible();
    if (await select.isVisible()) await select.selectOption(project.id);
    else await button.click();
  }
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await expect(page.getByLabel('New task title', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('personal-tasks.png') });
    await selectTeam();
    await page.screenshot({ path: info.outputPath('team-tasks.png') });
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
    await page.getByLabel('Message to Daymark assistant').fill('Ask Leo to review new tasks and block completion until their linked review is done.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const proposed = page.getByRole('article', { name: 'Proposed behavior' });
    await expect(proposed.getByText('For every new main task, Daymark adds “Review the deliverable” for Leo.', { exact: true })).toBeVisible();
    await expect(proposed.getByRole('heading', { name: 'Proposed behavior for Launch team' })).toBeVisible();
    expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(0);
    if (width === 390) {
      await page.route(`**/api/projects/${project.id}/authoring/confirm`, async route => {
        const saved = await route.fetch();
        expect(saved.status()).toBe(200);
        await route.abort('failed');
      }, { times: 1 });
    }
    await page.getByRole('button', { name: 'Confirm this behavior' }).click();
    await expect(page.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
    expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(1);
    const decision = page.getByRole('region', { name: 'Review and current use' });
    const behavior = decision.getByText('For every new main task, Daymark adds “Review the deliverable” for Leo.', { exact: true });
    const consequence = decision.getByText('When the linked task is completed, the main task can be completed.', { exact: true });
    await expect(behavior).toBeVisible();
    await expect(decision.getByRole('heading', { name: 'Proposed customization' })).toBeFocused();
    await expect(decision.getByRole('heading', { name: 'Proposed customization' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('ready-to-approve.png') });
    await page.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(page.getByText('Approved · Not on yet', { exact: true })).toBeVisible();
    await expect(decision).toContainText('Nothing is on for new tasks.');
    expect(fixture.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(project.id).revision_id).toBeNull();
    async function visibleDecision(next) {
      // No scroll or screenshot helpers between the click and these assertions.
      for (const part of [decision.getByText('Launch team · Team', { exact: true }),
        decision.getByRole('heading', { name: 'Proposed customization' }), behavior, consequence,
        decision.getByRole('status'), decision.getByRole('button', { name: next, exact: true })])
        await expect(part).toBeInViewport({ ratio: 1 });
    }
    await visibleDecision('Turn on for new tasks');
    await page.screenshot({ path: info.outputPath('approved-not-on.png') });
    const examples = page.getByRole('region', { name: 'Examples', exact: true });
    await examples.getByText('See how it works', { exact: true }).click();
    const business = examples.getByRole('article').filter({ has: page.getByRole('heading', { name: 'One example in Launch team' }) });
    await expect(business.getByRole('listitem')).toHaveText([
      'Maya adds “Prepare the release notes” (normal priority).',
      'Daymark adds “Review the deliverable” for Leo.',
      'Leo finishes “Review the deliverable”.',
      'Maya finishes “Prepare the release notes”.',
    ]);
    await business.scrollIntoViewIfNeeded();
    await expect(business.getByRole('heading')).toBeInViewport({ ratio: 1 });
    for (const step of await business.getByRole('listitem').all()) await expect(step).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('expanded-business-example.png') });
    const details = examples.getByText('Details · all 3 checks', { exact: true });
    await details.click();
    await expect(examples.getByText('The task stays open. Complete its linked review first.', { exact: true })).toHaveCount(2);
    await expect(examples.getByText('Example setup: The task is saved but the reply is lost.', { exact: true })).toBeVisible();
    await examples.getByText('Exact example results', { exact: true }).click();
    await expect(examples.locator('pre')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on for new tasks' }).click();
    await expect(page.getByText('On for new tasks', { exact: true })).toBeVisible();
    await visibleDecision('Back to project Tasks');
    await page.screenshot({ path: info.outputPath('turned-on.png') });
    await page.getByRole('button', { name: 'Back to project Tasks' }).click();
    await page.getByLabel('New task title', { exact: true }).fill('Launch brief');
    await expect(page.getByRole('heading', { name: 'Launch team', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('back-to-project-tasks.png') });
    await page.locator('.quick-add').getByRole('button', { name: /Add task/ }).click();
    const detail = page.getByRole('dialog', { name: 'Task details', exact: true });
    await page.getByRole('button', { name: 'Launch brief', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Open task: Review the deliverable' })).toBeVisible();
    await expect(detail.getByRole('region', { name: 'Last completion attempt' })).toHaveCount(0);
    await detail.getByRole('button', { name: 'Close task details' }).click();
    await page.getByRole('button', { name: 'Complete Launch brief', exact: true }).click();
    const row = page.locator('.task-row').filter({ has: page.getByRole('button', { name: 'Launch brief', exact: true }) });
    await expect(row).toContainText('Completion held on last attempt');
    await row.screenshot({ path: info.outputPath('after-activation-task-row.png') });
    await page.getByRole('button', { name: 'Launch brief', exact: true }).click();
    const hold = detail.getByRole('region', { name: 'Last completion attempt' });
    await expect(hold).toContainText('Complete its linked review first.');
    await expect(detail.getByText('“Review the deliverable” · Assigned to Leo · Open', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Customization Studio' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('linked-task.png') });
    await detail.getByRole('button', { name: 'Open task: Review the deliverable' }).click();
    await expect(detail.getByLabel('Task title')).toHaveValue('Review the deliverable');
    const openOriginal = detail.getByRole('region', { name: 'Original task' }).getByRole('button', { name: 'Open “Launch brief”' });
    await expect(openOriginal).toBeVisible();
    await page.screenshot({ path: info.outputPath('opened-linked-task.png') });
    await openOriginal.click();
    await expect(detail.getByLabel('Task title')).toHaveValue('Launch brief');
    await detail.getByRole('button', { name: 'Close task details' }).click();
    await switchPerson(page, 'leo');
    await selectTeam();
    await page.getByRole('button', { name: 'Complete Review the deliverable', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review the deliverable, completed', exact: true })).toBeDisabled();
    await switchPerson(page, 'maya');
    await selectTeam();
    await page.getByRole('button', { name: 'Complete Launch brief', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Launch brief, completed', exact: true })).toBeDisabled();
    expect(fixture.requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); await fixture.close(); }
});
