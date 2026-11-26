import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { allowMissingReview, linkedOffer, nestedOfferCalls, offerSources } from '../fixtures/team-authored.mjs';
import { navigate, openEarlierPersonalEditor, switchPerson } from '../fixtures/workspace-ui.mjs';
import { taskService } from '../../src/data.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { OPENAI_RESERVE_MICROS } from '../../src/authoring-config.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';
import { seedEarlierTeamDiscussion } from '../fixtures/task-authoring.mjs';

test.use({ hasTouch: true });

test('Personal confirms the exact offer, recovers a lost reply and keeps approval and activation separate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let program, calls = 0;
  const fixture = await startAuthoringFixture({ authoringOverride: {
    config: { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: OPENAI_RESERVE_MICROS, maxMicros: 3 * OPENAI_RESERVE_MICROS },
    providerFactory: config => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros, async complete(request) {
      calls++;
      expect(request.tools.some(tool => /resolve_intent|compile_draft|simulate_draft/.test(tool.name))).toBe(false);
      if (calls === 2) return { calls: [{ id: 'catalog', name: 'discover_catalog', arguments: {} }], text: '',
        usage: { inputTokens: 1, outputTokens: 1 } };
      if (calls === 3) {
        const { rejectedOffer } = JSON.parse(request.toolResult.output).result;
        expect(rejectedOffer.source).toBe('{');
        expect(rejectedOffer.cases).toEqual(program.cases);
        expect(rejectedOffer.diagnostics).toEqual([{ code: 'SYNTAX_INVALID', path: '/source' }]);
      }
      return { calls: [{ id: 'offer', name: 'offer_proposal', arguments: { hookId: 'TaskCompleted', sourceJson: calls === 1 ? '{' : program.source,
        cases: program.cases, expectedDraftVersion: 0, summary: 'Add a follow-up after completing a task in the chosen project.' } }],
        text: '', usage: { inputTokens: 1, outputTokens: 1 } };
    } }),
  } });
  try {
    program = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await navigate(page, 'Customizations');
    await openEarlierPersonalEditor(page, fixture);
    await page.getByLabel('Message to Daymark assistant', { exact: true }).fill('Create a follow-up when I complete a task in this project.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Confirm this behavior', exact: true });
    await expect(confirm).toBeEnabled();
    const count = table => fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    expect(count('extension_revisions')).toBe(0);
    expect(count('extension_evidence')).toBe(0);
    await confirm.tap();
    await expect(page.getByText(/No draft was saved\. Ask the assistant to correct the proposal/)).toBeVisible();
    await expect(confirm).toHaveCount(0);
    expect(calls).toBe(1);
    expect(count('extension_revisions')).toBe(0);
    expect(count('extension_evidence')).toBe(0);
    const composer = page.getByLabel('Message to Daymark assistant', { exact: true });
    await composer.fill('Please correct the proposal without changing the behavior.');
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await expect(confirm).toBeEnabled();
    expect(count('extension_revisions')).toBe(0);
    let posts = 0;
    await page.route('**/api/authoring/conversations/*/confirm', async route => {
      posts++;
      expect((await route.fetch()).status()).toBe(202);
      await route.abort('failed');
    });
    await confirm.click();
    await expect(page.getByText('The draft was saved and its examples passed. It is not approved or turned on.', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(calls).toBe(3);
    expect(count('extension_revisions')).toBe(1);
    expect(count('extension_approvals')).toBe(0);
    const active = () => fixture.db.prepare("SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get()?.revision_id;
    expect(active()).toBeNull();
    await page.getByRole('article').filter({ hasText: 'The draft was saved and its examples passed.' })
      .getByRole('button', { name: 'See proposed change', exact: true }).click();
    await page.getByRole('button', { name: 'View simulation', exact: true }).click();
    await page.getByRole('button', { name: 'Approve this change', exact: true }).click();
    const turnOn = page.getByRole('button', { name: 'Turn on for tasks completed', exact: true });
    await expect(turnOn).toBeEnabled();
    expect(active()).toBeNull();
    await turnOn.click();
    await expect.poll(active).not.toBeNull();
  } finally { await fixture.close(); }
});

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
       if (holdTurn) { holdTurn = false; await heldTurn; }
       expect(request.tools.some(tool => tool.name === 'resolve_intent')).toBe(false);
      expect(request.toolResult).toBeUndefined();
      expect(request.tools.some(tool => tool.name === 'discover_catalog')).toBe(false);
      const result = input.currentContext;
      expect(result.businessContext.members.map(p => p.id).sort()).toEqual(['leo', 'maya']);
      expect(result.businessContext.restriction).toContain('never starts another creation rule');
      expect(request.instructions).toContain('Do not ask the user to choose before answering basic capability questions');
      expect(request.instructions).not.toContain('Show business output, ordered calls, trace and receipts separately');
      expect(request.instructions).toContain('Missing is not done: deny both absent and open');
       if (input.currentUserMessage === 'What can we do here?') {
        return { calls: [], text: help, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (input.currentUserMessage.includes('Slack messages')) return reply('ask_clarification', { question: narrowing });
      if (input.currentUserMessage === 'Yes, leave out Slack.') {
         expect(input.transcript.messages.at(-1)).toEqual({ role: 'assistant', text: narrowing });
         expect(input.transcript.messages.at(-2).text).toContain('Slack messages');
      }
      if (width === 1440) return reply('offer_proposal', reviewOffer);
      return reply('offer_proposal', allowMissingReview(reviewOffer));
    },
  }) } });
  const project = taskService(fixture.db).createProject('maya', { name: 'Launch team', mode: 'TEAM' });
  seedEarlierTeamDiscussion(fixture.db, project.id);
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
    await earlierTeamWork(page);
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
    const behaviorText = 'For every new main task, Daymark adds “Review the deliverable” for Leo.';
    await expect(proposed.getByText(behaviorText, { exact: true })).toBeVisible();
    await expect(proposed.getByRole('heading', { name: 'Proposed behavior for Launch team' })).toBeVisible();
    await proposed.getByText('Examples', { exact: true }).click();
    await expect(proposed.getByText(/The task stays open\. Complete its linked review first\./)).toBeVisible();
    await proposed.getByText('Examples', { exact: true }).click();
    expect(fixture.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n).toBe(0);
    expect(requests).toHaveLength(width === 390 ? 5 : 2);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(requests.length * OPENAI_RESERVE_MICROS);
    if (width === 390) {
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await earlierTeamWork(page);
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
      expect(requests).toHaveLength(5);
      await page.route(`**/api/projects/${project.id}/authoring/confirm`, async route => {
        const saved = await route.fetch();
        expect(saved.status()).toBe(200);
        await route.abort('failed');
      }, { times: 1 });
    }
    await page.getByRole('button', { name: 'Confirm this behavior' }).click();
    await expect(page.getByRole('button', { name: 'Approve this draft' })).toBeEnabled({ timeout: 20_000 });
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
    await expect(examples.locator('pre')).toHaveCount(0);
    await expect(examples.getByText(/Details · all|Example setup|reply is lost/)).toHaveCount(0);
    await expect(page.getByText(/Support diagnostics|Saved action details/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Turn on for new tasks' }).click();
    await expect(page.getByText('On for new tasks', { exact: true })).toBeVisible();
    await visibleDecision('Back to project Tasks');
    await expect(page.getByRole('button', { name: 'Turn off for new tasks', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('turned-on.png') });
    const projectSelect = page.getByLabel('Personal or Team project', { exact: true });
    await projectSelect.scrollIntoViewIfNeeded();
    await expect(projectSelect).toBeInViewport({ ratio: 1 });
    const fit = await decision.evaluate(card => {
      const scroller = card.closest('.team-capability-body');
      const select = scroller.querySelector('.team-scope select');
      const action = card.querySelector('button');
      const bounds = scroller.getBoundingClientRect();
      const right = bounds.left + scroller.clientLeft + scroller.clientWidth;
      const bordersFit = [select, card, action].every(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= bounds.left + 6 && rect.right <= right - 6;
      });
      const hits = [select, action].map(el => {
        const rect = el.getBoundingClientRect();
        return document.elementFromPoint(rect.right - 6, rect.top + rect.height / 2)?.closest('select, button') === el;
      });
      return { bordersFit, hits, overflow: scroller.scrollWidth - scroller.clientWidth };
    });
    expect(fit).toEqual({ bordersFit: true, hits: [true, true], overflow: 0 });
    await page.screenshot({ path: info.outputPath('active-studio-scroll-edges.png') });
    await page.getByRole('button', { name: 'Back to project Tasks' }).click();
    await page.getByLabel('New task title', { exact: true }).fill('Launch brief');
    await expect(page.getByRole('heading', { name: 'Launch team', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('back-to-project-tasks.png') });
    await page.locator('.quick-add').getByRole('button', { name: /Add task/ }).click();
    const detail = page.getByRole('dialog', { name: 'Task details', exact: true });
    if (width === 1440) {
      // Simulate one uncertain read; the button then uses the real saved-result endpoint.
      await page.route(/\/api\/tasks\/[^/]+\/reaction\?trigger=TaskCreated$/, async route => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ response, json: { ...data, team: true, state: 'FINISHED', receipt: null,
          reconciliation: null, outcome: { classification: 'UNCERTAIN' } } });
      }, { times: 1 });
    }
    await page.getByRole('button', { name: 'Launch brief', exact: true }).click();
    if (width === 1440) {
      const outcome = detail.getByRole('region', { name: 'Task creation customization outcome' });
      await expect(outcome).toContainText('We haven’t confirmed a linked task. It may already exist.');
      await expect(outcome.locator('pre')).toHaveCount(0);
      const checked = page.waitForResponse(r => r.url().includes('/reaction/reconcile') && r.request().method() === 'POST');
      await outcome.getByRole('button', { name: 'Check again' }).click();
      expect((await checked).status()).toBe(200);
    }
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
    const completed = page.locator('.task-row').filter({ has: page.getByRole('button', { name: 'Launch brief, completed', exact: true }) });
    const completedOutcome = completed.getByRole('region', { name: 'Task creation customization outcome' });
    await expect(completedOutcome).toContainText('“Review the deliverable” · Assigned to Leo · Completed');
    await expect(completedOutcome.locator('pre, details')).toHaveCount(0);
    await completed.screenshot({ path: info.outputPath('completed-original-business-outcome.png') });
    await completed.getByRole('button', { name: 'Open task: Review the deliverable' }).click();
    await expect(detail.getByRole('region', { name: 'Original task' })).toContainText('Launch brief');
    expect(fixture.requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { releaseTurn(); await page.close(); await fixture.close(); }
});

test('Team confirmation distinguishes definite rejection, unknown delivery and a saved draft whose check failed', async ({ page }, info) => {
  const fixture = await startAuthoringFixture({ authoringOverride: {
    config: { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: OPENAI_RESERVE_MICROS, maxMicros: 4_000_000 },
    providerFactory: config => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros, async complete(request) {
      const offer = linkedOffer();
      if (JSON.parse(request.input).currentUserMessage === 'Prepare the first proposal') {
        // A real compiler error, not a mocked HTTP rejection and not one the offer contract claims to catch.
        const source = JSON.parse(offer.TaskCreated.source);
        source.return.record.status = { cel: 'unboundResult' };
        offer.TaskCreated.source = JSON.stringify(source);
      }
       return { calls: [{ id: 'offer', name: 'offer_proposal', arguments: offer }], text: '', usage: { inputTokens: 1, outputTokens: 1 } };
    } }),
  } });
  const project = taskService(fixture.db).createProject('maya', { name: 'Launch team', mode: 'TEAM' });
  seedEarlierTeamDiscussion(fixture.db, project.id);
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
  const reopen = async () => {
    await page.getByRole('button', { name: 'Back to Customizations' }).click();
    await earlierTeamWork(page);
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await navigate(page, 'Customizations');
    await earlierTeamWork(page);
    await submitted('Prepare the first proposal');
    const rejection = page.waitForResponse(response => new URL(response.url()).pathname === path);
    await confirm.click();
    expect((await rejection).status()).toBe(422);
    const unsaved = proposal.getByRole('alert').filter({ hasText: 'No draft was saved for it' });
    await expect(unsaved).toBeInViewport({ ratio: 0.99 });
    await expect(confirm).toHaveCount(0);
    expect(revisions()).toBe(0);
    await reopen();
    await expect(unsaved).toBeInViewport({ ratio: 0.99 });
    await expect(confirm).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('confirm-definitely-unsaved.png') });

    await submitted('Prepare a fresh proposal');
    await page.route(`**${path}`, route => route.abort('failed'), { times: 1 });
    await confirm.click();
    const unknown = proposal.getByRole('status').filter({ hasText: 'couldn’t tell whether the draft was saved' });
    await expect(unknown).toBeInViewport({ ratio: 0.99 });
    await expect(unsaved).toHaveCount(0);
    await unknown.getByRole('button', { name: 'Check saved state' }).click();
    await reopen();
    await expect(unknown).toBeInViewport({ ratio: 0.99 });
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
async function earlierTeamWork(page) {
  await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
  await page.getByText('More', { exact: true }).click();
  await page.getByRole('button', { name: 'Open earlier Team work' }).click();
}
