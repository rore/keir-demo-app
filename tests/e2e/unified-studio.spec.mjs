import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { allowMissingReview, linkedOffer, nestedOfferCalls, offerSources } from '../fixtures/team-authored.mjs';
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
  const help = `${question}\n- Add a **linked review**\n- Use a \`fixed title\` <img src=x onerror=alert(1)>`;
  const narrowing = 'Daymark can’t send Slack messages. Should I prepare the linked review without Slack?';
  const reviewOffer = nestedOfferCalls(offerSources(linkedOffer(), true));
  if (width === 1440) reviewOffer.TaskCreated.outcomes[0].when.priority = ['low', 'normal', 'high'];
  const fixture = await startAuthoringFixture({ authoringOverride: {
    config: { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: OPENAI_RESERVE_MICROS, maxMicros: 4_000_000 },
    providerFactory: config => ({
    reserveMicros: config.reserveMicros, maxMicros: config.maxMicros,
    complete: async request => {
      if (request.toolResult) {
        requests.push('correct-offer');
        expect(request.tools.map(tool => tool.name)).toEqual(['offer_proposal']);
        expect(JSON.parse(request.toolResult.output)).toMatchObject({
          ok: false, saved: false, remainingAttempts: 1,
          diagnostics: [{ code: 'FINISHED_REVIEW_REQUIRED', path: '/TaskBeforeComplete/outcomes' }],
        });
        const corrected = reply('offer_proposal', reviewOffer);
        corrected.calls[0].id = 'corrected-offer';
        return corrected;
      }
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
      expect(request.instructions).not.toContain('Show business output, ordered calls, trace and receipts separately');
      expect(request.instructions).toContain('Missing is not done: deny both absent and open');
      if (input.hostContext.intent === 'discuss') {
        expect(request.tools.some(tool => tool.name === 'offer_proposal')).toBe(false);
        return { calls: [], text: help, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (input.currentUserMessage.includes('Slack messages')) return reply('ask_clarification', { question: narrowing });
      if (input.currentUserMessage === 'Yes, leave out Slack.') {
        expect(input.clarificationContext).toBe(narrowing);
        expect(input.previousUserMessages.at(-1)).toContain('Slack messages');
      }
      if (width === 1440) return reply('offer_proposal', reviewOffer);
      return reply('offer_proposal', allowMissingReview(reviewOffer));
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
    const helpReply = page.locator('.team-message-assistant');
    await expect(helpReply.getByRole('listitem').filter({ hasText: 'Add a linked review' })).toBeVisible();
    await expect(helpReply.locator('li strong')).toHaveText('linked review');
    await expect(helpReply.locator('code')).toHaveText('fixed title');
    await expect(helpReply.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
    await expect(helpReply.locator('img, .rs-message')).toHaveCount(0);
    if (width === 390) {
      await send('Add a linked review for Leo to every new task. The original may only be finished after its review is done. Also send Slack messages.');
      await expect(page.getByText(narrowing, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm this behavior' })).toHaveCount(0);
      await send('Yes, leave out Slack.');
    } else await send('Add a linked review for Leo when someone adds a task. Keep the original open until its review is finished.');
    const proposed = page.getByRole('article', { name: 'Proposed behavior' });
    const behaviorText = width === 390 ? 'For every new main task, Daymark adds “Review the deliverable” for Leo.'
      : 'When priority is low, normal, or high, Daymark adds “Review the deliverable” for Leo.';
    await expect(proposed.getByText(behaviorText, { exact: true })).toBeVisible();
    await expect(proposed.getByRole('heading', { name: 'Proposed behavior for Launch team' })).toBeVisible();
    await proposed.getByText('Examples', { exact: true }).click();
    await expect(proposed.getByText(/The task stays open\. Complete its linked review first\./)).toBeVisible();
    await proposed.getByText('Examples', { exact: true }).click();
    expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(0);
    expect(requests).toHaveLength(width === 390 ? 8 : 4);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(requests.length * OPENAI_RESERVE_MICROS);
    if (width === 390) {
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
      const latest = page.getByRole('log', { name: 'Latest messages', exact: true });
      await expect(latest).toContainText('Yes, leave out Slack.');
      await expect(latest).toBeInViewport({ ratio: 1 });
      const confirm = proposed.getByRole('button', { name: 'Confirm this behavior' });
      await expect(confirm).toBeInViewport({ ratio: 1 });
      const composer = page.getByLabel('Message to Daymark assistant');
      expect(await proposed.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('#studio-message')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      await composer.scrollIntoViewIfNeeded();
      await expect(composer).toBeInViewport({ ratio: 1 });
      expect(await page.locator('.team-capability .rs-chat').evaluate(node => getComputedStyle(node).overflowY)).toBe('visible');
      await page.screenshot({ path: info.outputPath('team-chat-reopened-touch.png') });
      await expect(page.getByText(question, { exact: true })).toBeHidden();
      await page.getByText('Earlier messages', { exact: true }).click();
      await expect(page.getByText(question, { exact: true })).toBeVisible();
      await page.getByText('Earlier messages', { exact: true }).click();
      expect(requests).toHaveLength(8);
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
    const behavior = decision.getByText(behaviorText, { exact: true });
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
      `Maya adds “Example original task” (${width === 390 ? 'normal' : 'low'} priority).`,
      'Daymark adds “Review the deliverable” for Leo.',
      'Leo finishes “Review the deliverable”.',
      'Maya finishes “Example original task”.',
    ]);
    await business.scrollIntoViewIfNeeded();
    await expect(business.getByRole('heading')).toBeInViewport({ ratio: 1 });
    for (const step of await business.getByRole('listitem').all()) await expect(step).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('expanded-business-example.png') });
    const details = examples.getByText(`Details · all ${width === 390 ? 3 : 9} checks`, { exact: true });
    await details.click();
    await expect(examples.getByText('The task stays open. Complete its linked review first.', { exact: true })).toHaveCount(width === 390 ? 2 : 6);
    await expect(examples.getByText('Example setup: The task is saved but the reply is lost.', { exact: true }).first()).toBeVisible();
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

test('Team confirmation distinguishes definite rejection, unknown delivery and a saved draft whose check failed', async ({ page }, info) => {
  const fixture = await startAuthoringFixture({ authoringOverride: {
    config: { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: OPENAI_RESERVE_MICROS, maxMicros: 4_000_000 },
    providerFactory: config => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros, async complete(request) {
      const isIntent = request.tools[0].name === 'resolve_intent';
      const offer = linkedOffer();
      if (JSON.parse(request.input).currentUserMessage === 'Prepare the first proposal') {
        // A real compiler error, not a mocked HTTP rejection and not one the offer contract claims to catch.
        const source = JSON.parse(offer.TaskCreated.source);
        source.return.record.status = { cel: 'unboundResult' };
        offer.TaskCreated.source = JSON.stringify(source);
      }
      return { calls: [{ id: isIntent ? 'intent' : 'offer', name: isIntent ? 'resolve_intent' : 'offer_proposal',
        arguments: isIntent ? { intent: 'prepare', question: '' } : offer }], text: '', usage: { inputTokens: 1, outputTokens: 1 } };
    } }),
  } });
  const project = taskService(fixture.db).createProject('maya', { name: 'Launch team', mode: 'TEAM' });
  teamProjectService(fixture.db).addMember('maya', project.id, { userId: 'leo' });
  const path = `/api/projects/${project.id}/authoring/confirm`;
  let confirmations = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === path && request.method() === 'POST') confirmations++; });
  const proposal = page.getByRole('article', { name: 'Proposed behavior' });
  const confirm = proposal.getByRole('button', { name: 'Confirm this behavior' });
  const revisions = () => fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n;
  const submitted = async text => {
    await page.getByLabel('Message to Daymark assistant').fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(confirm).toBeEnabled();
  };
  const reopen = async label => {
    await page.getByRole('button', { name: 'Back to Customizations' }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await submitted('Prepare the first proposal');
    const rejection = page.waitForResponse(response => new URL(response.url()).pathname === path);
    await confirm.click();
    expect((await rejection).status()).toBe(422);
    const unsaved = proposal.getByRole('alert').filter({ hasText: 'No draft was saved for it' });
    await expect(unsaved).toBeInViewport({ ratio: 1 });
    await expect(confirm).toHaveCount(0);
    expect(revisions()).toBe(0);
    await reopen('Open Studio');
    await expect(unsaved).toBeInViewport({ ratio: 1 });
    await expect(confirm).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('confirm-definitely-unsaved.png') });

    await submitted('Prepare a fresh proposal');
    await page.route(`**${path}`, route => route.abort('failed'), { times: 1 });
    await confirm.click();
    const unknown = proposal.getByRole('status').filter({ hasText: 'couldn’t tell whether the draft was saved' });
    await expect(unknown).toBeInViewport({ ratio: 1 });
    await expect(unsaved).toHaveCount(0);
    await unknown.getByRole('button', { name: 'Check saved state' }).click();
    await reopen('Open Studio');
    await expect(unknown).toBeInViewport({ ratio: 1 });
    await expect(confirm).toHaveCount(0);
    expect(confirmations).toBe(2);
    expect(revisions()).toBe(0);
    await page.screenshot({ path: info.outputPath('confirm-unknown-readback.png') });

    fixture.db.exec("CREATE TEMP TRIGGER fail_team_evidence BEFORE INSERT ON team_evidence BEGIN SELECT RAISE(ABORT,'Test: check unavailable'); END");
    await submitted('Prepare a new proposal');
    await confirm.click();
    const saved = page.getByRole('region', { name: 'Review and current use' });
    await expect(saved.getByText('The draft was saved, but its examples couldn’t be checked.', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(saved.getByRole('button', { name: 'Check examples' })).toBeEnabled();
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toHaveCount(0);
    await expect(proposal).toHaveCount(0);
    expect(revisions()).toBe(1);
    expect(confirmations).toBe(3);
    await page.screenshot({ path: info.outputPath('confirm-saved-check-unavailable.png') });
  } finally { await page.close(); await fixture.close(); }
});
