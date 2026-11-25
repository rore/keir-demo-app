import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { linkedProposal } from '../fixtures/team-authored.mjs';
import { navigate, switchPerson } from '../fixtures/workspace-ui.mjs';
import { taskService } from '../../src/data.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { OPENAI_RESERVE_MICROS } from '../../src/authoring-config.mjs';

test.use({ hasTouch: true });

for (const width of [1440, 390]) test(`one Team conversation to linked task at ${width}px`, async ({ page }, info) => {
  const reply = (name, args) => ({ calls: [{ id: name, name, arguments: args }], text: '', usage: { inputTokens: 1, outputTokens: 1 } });
  let holdTurn = width === 390, releaseTurn;
  const heldTurn = new Promise(resolve => { releaseTurn = resolve; });
  const requests = [];
  const question = 'I can add a linked review for a teammate, do that only for high-priority tasks, and keep the original open until the review is done.';
  const narrowing = 'Daymark can’t send email. Should I prepare the linked review without email?';
  const fixture = await startAuthoringFixture({ authoringOverride: {
    config: { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: OPENAI_RESERVE_MICROS, maxMicros: 4_000_000 },
    providerFactory: config => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    complete: async request => {
      const input = JSON.parse(request.input);
      requests.push(input.currentUserMessage);
      if (request.tools[0].name === 'resolve_intent') {
        if (holdTurn) { holdTurn = false; await heldTurn; }
        expect(request.instructions).toContain('A general question about what this workspace can do is discuss');
        return reply('resolve_intent', { intent: input.currentUserMessage === 'What can we do here?' ? 'discuss' : 'prepare', question: '' });
      }
      expect(request.toolResult).toBeUndefined();
      expect(request.tools.some(tool => tool.name === 'discover_catalog')).toBe(false);
      const result = input.currentContext;
      expect(result.businessContext.members.map(p => p.id).sort()).toEqual(['leo', 'maya']);
      expect(result.businessContext.restriction).toContain('never starts another creation rule');
      expect(request.instructions).toContain('Do not ask the user to choose before answering basic capability questions');
      if (input.hostContext.intent === 'discuss') {
        expect(request.tools.some(tool => tool.name === 'offer_proposal')).toBe(false);
        return { calls: [], text: question, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (input.currentUserMessage.includes('email reminders')) return reply('ask_clarification', { question: narrowing });
      if (input.currentUserMessage === 'Yes, leave out the email.') {
        expect(input.clarificationContext).toBe(narrowing);
        expect(input.previousUserMessages.at(-1)).toContain('email reminders');
      }
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
    const personal = page.getByRole('button', { name: 'Gather material references', exact: true });
    const personalDetail = page.getByRole('dialog', { name: 'Task details', exact: true });
    const selection = page.waitForResponse(r => new URL(r.url()).pathname === '/api/extensions' && r.request().method() === 'GET');
    await personal.click();
    expect((await (await selection).json()).selection.revision).toBeNull();
    await expect(personalDetail.getByRole('button', { name: 'Customization Studio', exact: true })).toHaveCount(0);
    await personalDetail.getByRole('button', { name: 'Close task details' }).click();
    const noBinding = page.waitForResponse(r => /\/api\/tasks\/[^/]+\/reaction$/.test(r.url()));
    await page.getByRole('button', { name: 'Complete Gather material references', exact: true }).click();
    expect((await (await noBinding).json()).state).toBe('NO_BINDING');
    await expect(page.getByRole('button', { name: 'Gather material references, completed', exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Customization outcome', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('personal-tasks.png') });
    await selectTeam();
    await page.screenshot({ path: info.outputPath('team-tasks.png') });
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    if (width === 390) {
      const scope = page.getByLabel('Personal or Team project', { exact: true });
      await expect(scope).toHaveValue(project.id);
      expect(await scope.evaluate(select => {
        const style = getComputedStyle(select), context = document.createElement('canvas').getContext('2d');
        context.font = `${style.fontSize} ${style.fontFamily}`;
        return context.measureText(select.selectedOptions[0].text).width + parseFloat(style.paddingLeft) + 36 <= select.clientWidth;
      })).toBe(true);
      await scope.tap();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: info.outputPath('team-scope-touch.png') });
      await page.getByLabel('Message to Daymark assistant').fill('I want to change the review process.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByText('Stopping…', { exact: true })).toBeVisible();
      releaseTurn();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Confirm this behavior' })).toHaveCount(0);
      expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(0);
    }
    const send = async text => {
      await page.getByLabel('Message to Daymark assistant').fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    };
    await send('What can we do here?');
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await send('Ask Leo to review new tasks and block completion until their linked review is done. Also send email reminders.');
    await expect(page.getByText(narrowing, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm this behavior' })).toHaveCount(0);
    await send('Yes, leave out the email.');
    const proposed = page.getByRole('article', { name: 'Proposed behavior' });
    await expect(proposed.getByText('For every new main task, Daymark adds “Review the deliverable” for Leo.', { exact: true })).toBeVisible();
    await expect(proposed.getByRole('heading', { name: 'Proposed behavior for Launch team' })).toBeVisible();
    expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(0);
    expect(requests).toHaveLength(width === 390 ? 7 : 6);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(requests.length * OPENAI_RESERVE_MICROS);
    if (width === 390) {
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
      const latest = page.getByRole('log', { name: 'Latest messages', exact: true });
      await expect(latest).toContainText('Yes, leave out the email.');
      await expect(latest).toBeInViewport();
      await expect(page.getByText(question, { exact: true })).toBeHidden();
      await page.getByText('Earlier messages', { exact: true }).click();
      await expect(page.getByText(question, { exact: true })).toBeVisible();
      await page.getByText('Earlier messages', { exact: true }).click();
      expect(requests).toHaveLength(7);
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
         decision.getByRole('heading', { name: next === 'Back to project Tasks' ? 'Customization in use' : 'Proposed customization', exact: true }), behavior, consequence,
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
    await expect(row.getByText('This task stayed open.', { exact: true })).toBeVisible();
    await expect(row).toContainText('Complete its linked review first.');
    await expect(page.getByText('Task added.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Launch brief stayed open on the last attempt.' })).toHaveCount(1);
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
    await expect(page.getByText('Assigned to Leo (you)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Complete Review the deliverable', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review the deliverable, completed', exact: true })).toBeDisabled();
    await switchPerson(page, 'maya');
    await selectTeam();
    await page.getByRole('button', { name: 'Complete Launch brief', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Launch brief, completed', exact: true })).toBeDisabled();
    expect(fixture.requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { releaseTurn(); await page.close(); await fixture.close(); }
});
