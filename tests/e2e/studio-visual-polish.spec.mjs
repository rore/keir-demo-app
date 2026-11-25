import { test, expect } from '@playwright/test';
import { openDeveloperTools } from '../fixtures/studio-review.mjs';
import { openWorkspaceTool } from '../fixtures/workspace-ui.mjs';
import { writeFileSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskTagNotesFixture } from '../fixtures/task-tag-notes.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { createCompiler } from '../../src/compiler.mjs';

// Same fictional conversation as the accepted visual reference. This exercises the real React app,
// compiler and saved evidence; assistant messages are scripted, not live-model qualification.
const messages = [
  ['user', 'Before saving a new task, require notes if it has more than three tags. Apply this in every project.'],
  ['assistant', 'I can check new tasks before they are saved. Should this only affect new tasks, leaving existing tasks and later edits unchanged?'],
  ['user', 'Yes. Only new tasks, across every project. Three tags or fewer should not require notes.'],
  ['assistant', 'Then saving stops only when a new task has four or more distinct normalized tags and no notes. Whitespace-only notes count as no notes. Existing tasks and later edits stay unchanged.'],
  ['user', 'What if I enter Launch twice, with different capitalization or a space at the end?'],
  ['assistant', 'Tags are trimmed, Unicode-normalized, lowercased and deduplicated before counting. “Launch”, “launch” and “launch ” count as one tag, not three.'],
  ['user', 'Prepare that rule. Check three tags, four tags, four with notes, and four with whitespace-only notes.'],
  ['assistant', 'The draft is ready, but it is not on. Four example decisions matched their expectations: two stopped saving and two allowed normal save checks to continue. Other situations remain untested.'],
].map(([role, text], index) => ({ id: 'visual-' + index, role, text, kind: 'text' }));

const ui = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const summary = page => ui(page).getByRole('article', { name: 'About this rule', exact: true });
const simulation = page => ui(page).getByRole('article', { name: 'Current decision', exact: true });
const composer = page => ui(page).getByLabel('Message to Daymark assistant', { exact: true });
const log = page => ui(page).getByRole('log', { name: 'Studio conversation', exact: true });
const domain = db => Object.fromEntries(['tasks', 'extension_revisions', 'extension_authored', 'extension_evidence', 'extension_approvals', 'extension_selections']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

async function prepare(page, { proof = true, paged = false, fullGuardSuite = false } = {}) {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const lifecycle = createLifecycle(fixture.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
  const rule = taskTagNotesFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId });
  // Saved proposals contain hasNotes, not raw notes. This repeats a decision, not a normalization check.
  const repeated = JSON.parse(rule.cases[2]); repeated.id = 'four-tags-no-notes-again';
  const cases = fullGuardSuite ? rule.cases : [rule.cases[1], rule.cases[2], rule.cases[3], JSON.stringify(repeated)];
  const name = proof ? 'Tag count check' : 'Tag count check — require notes for new tasks across launch and onboarding teams';
  const { extensionId } = admitTaskDraft(fixture.db, lifecycle, { name });
  let state = await lifecycle.compile('maya', { extensionId, hookId: 'TaskBeforeCreate', source: rule.source, draftVersion: 0 }, () => {});
  state = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases }, () => {});
  if (proof) state = await lifecycle.simulate('maya', { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion }, () => {});
  const current = { id: 'visual-conversation', extensionId, purpose: 'REVISE', version: 1, runId: 'visual-run',
    operation: { id: 'visual-operation', version: 1, runId: 'visual-run' }, status: 'AWAITING_USER', code: null,
    draft: { revisionId: state.draft.id, draftVersion: state.draftVersion, suiteDigest: state.draft.suiteDigest },
    selection: { revisionId: null, generation: state.selection.generation }, review: null,
    messages: messages.map((message, index) => proof && index === 7 ? { ...message, kind: 'review',
      receipt: { revisionId: state.draft.id, draftVersion: state.draftVersion, suiteDigest: state.draft.suiteDigest, evidenceId: state.evidence.id } } : message),
    messagesBefore: paged ? 'visual-older-page' : null };
  const posted = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/authoring**', route => {
    const request = route.request();
    if (request.method() !== 'GET') { posted.push(request.url()); return route.fulfill({ status: 500, json: { message: 'Unexpected authoring write.' } }); }
    return route.fulfill({ json: new URL(request.url()).pathname === '/api/authoring'
      ? { availability: { available: true, code: null, provider: 'openai', model: 'scripted-visual-only' },
        current, conversations: [{ id: current.id, extensionId, purpose: current.purpose, version: 1, status: current.status,
          runId: current.runId, operationId: current.operation.id, creationOperationId: 'visual-creation' }], next: null,
          ...(paged && { transcript: { messages: current.messages.map(message => ({ ...message, conversationId: current.id })), next: 'visual-older-page' } }) }
      : current });
  });
  if (!proof) await page.route(`**/api/extensions/${extensionId}/revisions/${state.draft.id}`, async route => {
    const response = await route.fetch(), value = await response.json();
    await route.fulfill({ response, json: { ...value, artifact: value.artifact + 'invalid-pinned-bytes' } });
  });
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
   await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator(`[id="edit-${extensionId}"]`).click();
  await expect(ui(page).locator('#studio-title')).toHaveText(name);
  await expect(ui(page).locator('[data-conversation-message]')).toHaveCount(8);
  return { ...fixture, lifecycle, state, current, posted, errors };
}

async function measure(page) {
  return ui(page).evaluate(root => {
    const rect = selector => root.querySelector(selector).getBoundingClientRect();
    const header = rect('.rs-header'), transcript = rect('.rs-messages'), input = rect('.rs-composer');
    const blocks = [...root.querySelectorAll('[data-conversation-message]')].map(node => node.getBoundingClientRect());
    return { headerHeight: header.height, transcriptHeight: transcript.height, composerHeight: input.height,
      composerBottom: input.bottom, viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth, fullMessages: blocks.filter(block => block.top >= transcript.top && block.bottom <= transcript.bottom).length,
      messagePixels: blocks.reduce((sum, block) => sum + Math.max(0, Math.min(block.bottom, transcript.bottom) - Math.max(block.top, transcript.top)), 0),
      scroller: getComputedStyle(root.querySelector('.rs-messages')).overflowY, pageScroller: getComputedStyle(root).overflowY };
  });
}

for (const viewport of [{ width: 1920, height: 1028 }, { width: 626, height: 900 }, { width: 390, height: 844 }])
for (const proof of [true, false]) test(`chat-first full documents preserve reading and input at ${viewport.width}x${viewport.height} (${proof ? 'checked' : 'no proof, unavailable description, long name'})`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(viewport);
  const fixture = await prepare(page, { proof });
  try {
    const before = domain(fixture.db), input = composer(page), headerSummary = ui(page).locator('#studio-view-saved');
    await expect(summary(page)).toBeHidden(); await expect(simulation(page)).toBeHidden();
    await expect(ui(page).getByRole('button', { name: 'Send', exact: true })).toHaveCount(1);
    await input.fill('Keep this unsent correction.');
    await expect(input).toBeInViewport();
    const geometry = await measure(page);
    expect(geometry.pageWidth).toBeLessThanOrEqual(viewport.width);
    expect(geometry.composerBottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(geometry.scroller).toBe('auto'); expect(geometry.pageScroller).not.toBe('auto');
    // The accepted composition uses larger distinct voices, not the rejected R3 message-count geometry.
    expect(geometry.transcriptHeight).toBeGreaterThanOrEqual(180);
    if (proof) expect(geometry.fullMessages).toBeGreaterThanOrEqual(1);
    expect(await ui(page).evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(960);
    expect(await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    })).toEqual([]);
    await info.attach('chat-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('chat.png') });
    await log(page).evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('chat-start.png') });
    writeFileSync(info.outputPath('chat-geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
    for (const position of ['top', 'middle', 'latest']) {
      await log(page).evaluate((node, position) => { node.scrollTop = position === 'top' ? 0 : position === 'middle' ? (node.scrollHeight - node.clientHeight) / 2 : node.scrollHeight; }, position);
      const top = await log(page).evaluate(node => node.scrollTop);
      await headerSummary.click();
      await expect(summary(page).getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
      await expect(summary(page)).toBeVisible();
      const returnToChat = ui(page).getByRole('button', { name: 'Back to conversation', exact: true });
      await expect(returnToChat).toHaveCount(1);
      await expect(returnToChat).toBeInViewport({ ratio: 1 });
      if (proof) {
        await expect(summary(page)).toContainText('Whitespace-only notes');
        if (!await summary(page).locator('.rs-rule-details').evaluate(node => node.open))
          await summary(page).getByText('Rule details', { exact: true }).click();
        await expect(summary(page).locator('.rs-rule-summary')).toBeVisible();
        await expect(summary(page).locator('.rs-rule-summary')).toContainText('3');
        if (position === 'latest') await page.screenshot({ path: info.outputPath('summary.png') });
        if (position === 'middle') {
          await ui(page).getByRole('button', { name: 'More', exact: true }).click();
          await expect(ui(page).locator('#studio-more-heading')).toBeFocused();
          await ui(page).locator('.rs-preview .rs-close-review').click();
          await expect(ui(page).getByRole('button', { name: 'More', exact: true })).toBeFocused();
          await expect(summary(page)).toBeVisible();
        }
        await summary(page).getByRole('button', { name: 'View simulation', exact: true }).click();
        await expect(simulation(page).getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
        await expect(returnToChat).toBeInViewport({ ratio: 1 });
        await expect(simulation(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
        await expect(simulation(page)).toContainText('Approval does not turn it on');
        await expect(simulation(page).locator('.rs-simulation-heading')).toContainText('4 examples shown');
        const rows = simulation(page).locator('.rs-guard-case');
        await expect(rows).toHaveCount(4);
        await expect(rows.first().locator('.rs-case-situation h4')).toHaveText('New task · 3 tags · No notes');
        await expect(rows.nth(1).locator('.rs-case-outcome strong')).toHaveText('Blocked');
        await expect(rows.first().locator('.rs-case-overview > *')).toHaveCount(3);
        await expect(rows.first().locator('.rs-case-disclosure')).not.toHaveAttribute('open');
        await expect(rows.first().locator('.rs-case-support')).toBeHidden();
        const columns = await rows.first().locator('.rs-case-overview').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
        expect(columns).toBe(viewport.width <= 420 ? 1 : 3);
        await expect(simulation(page).getByText('Not covered by this simulation', { exact: true })).toBeVisible();
        if (position === 'latest') await page.screenshot({ path: info.outputPath('simulation.png') });
        await rows.first().locator('summary').first().click();
        await expect(rows.first().locator('.rs-case-support')).toBeVisible();
        await expect(rows.first().locator('.rs-case-support')).toContainText('Expected');
        await expect(rows.first().locator('.rs-case-support')).toContainText('Observed');
        if (position === 'latest') await page.screenshot({ path: info.outputPath('simulation-expanded.png') });
        await rows.first().locator('summary').first().click();
      } else {
        await expect(summary(page)).toContainText('A full summary of this rule is unavailable.');
        await expect(summary(page).getByRole('button', { name: 'View simulation', exact: true })).toHaveCount(0);
        await expect(simulation(page)).toBeHidden();
      }
      await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(summary(page)).toBeHidden(); await expect(simulation(page)).toBeHidden();
      await expect(headerSummary).toBeFocused();
      expect(Math.abs(await log(page).evaluate(node => node.scrollTop) - top)).toBeLessThan(3);
      await expect(input).toHaveValue('Keep this unsent correction.');
    }
    await page.screenshot({ path: info.outputPath('returned-chat.png') });
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]); expect(fixture.errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('closing a pending Simulation cannot reopen it or move returned chat focus', async ({ page }) => {
  const fixture = await prepare(page);
  let release;
  try {
    await composer(page).fill('Keep this draft while the evidence and viewport change.');
    await ui(page).locator('#studio-view-saved').click();
    const started = Promise.withResolvers(), held = Promise.withResolvers();
    release = held.resolve;
    await page.route(`**/api/extensions/${fixture.state.extension.id}/evidence/${fixture.state.evidence.id}`, async route => {
      const response = await route.fetch(); started.resolve(); await held.promise; await route.fulfill({ response });
    }, { times: 1 });
    await summary(page).getByRole('button', { name: 'View simulation', exact: true }).click();
    await started.promise;
    await page.setViewportSize({ width: 390, height: 844 });
    await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(ui(page).locator('#studio-view-saved')).toBeFocused();
    await expect(composer(page)).toHaveValue('Keep this draft while the evidence and viewport change.');
    const response = page.waitForResponse(value => value.url().endsWith('/evidence/' + fixture.state.evidence.id));
    release(); await response;
    await expect(summary(page)).toBeHidden(); await expect(simulation(page)).toBeHidden();
    await expect(ui(page).locator('#studio-view-saved')).toBeFocused();
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { release?.(); await page.close(); await fixture.close(); }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 683, height: 384 },
  { width: 1001, height: 700 }, { width: 626, height: 550 }]) {
  test(`chat keeps readable space, input and usable actions at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await prepare(page, { proof: viewport.height >= 700 });
    try {
      const input = composer(page);
      await input.fill('Keep my first line.\nKeep my second line.');
      await expect(input).toBeInViewport({ ratio: 1 });
      await expect(ui(page).getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(log(page)).toBeInViewport({ ratio: 1 });
      expect((await log(page).boundingBox()).height).toBeGreaterThanOrEqual(80);
      if (viewport.width === 1440) {
        const geometry = await measure(page);
        expect(geometry.transcriptHeight).toBeGreaterThanOrEqual(690);
        expect((await log(page).boundingBox()).width).toBeGreaterThanOrEqual(950);
      }
      const more = ui(page).getByRole('button', { name: 'More', exact: true });
      await more.click();
      await expect(ui(page).locator('#studio-more-heading')).toBeFocused();
      await ui(page).locator('.rs-preview .rs-close-review').click();
      await expect(more).toBeFocused();
      await expect(input).toHaveValue('Keep my first line.\nKeep my second line.');
      await expect(input).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('usable-chat.png') });
      expect(fixture.errors).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}

test('returning to chat skips an invoker that became disabled', async ({ page }) => {
  const fixture = await prepare(page);
  try {
    const header = ui(page).locator('#studio-view-saved');
    await header.click();
    await expect(summary(page)).toBeVisible();
    await header.evaluate(node => { node.disabled = true; });
    await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(composer(page)).toBeFocused();
    await expect(summary(page)).toBeHidden();
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('short active chat keeps setup notice, current-use actions and composer reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 683, height: 384 });
  const fixture = await prepare(page);
  try {
    const input = { extensionId: fixture.state.extension.id, revisionId: fixture.state.draft.id,
      draftVersion: fixture.state.draftVersion, evidenceId: fixture.state.evidence.id };
    fixture.lifecycle.approve('maya', input, () => {});
    fixture.lifecycle.activate('maya', { ...input, generation: fixture.state.selection.generation }, () => {});
    await page.route('**/api/authoring**', route => route.fulfill({ json: {
      availability: { available: false, code: 'AI_NOT_CONFIGURED' }, current: fixture.current,
      conversations: [], next: null,
    } }));
    await page.reload();
    const off = ui(page).getByRole('button', { name: 'Turn off this customization', exact: true });
    await expect(off).toBeVisible();
    await expect(ui(page).getByText('Set up the assistant to create or change a customization.', { exact: true })).toBeVisible();
    await expect(composer(page)).toBeInViewport({ ratio: 1 });
    await expect(ui(page).getByRole('button', { name: 'Configure', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(off).toBeInViewport({ ratio: 1 });
    expect((await log(page).boundingBox()).height).toBeGreaterThanOrEqual(80);
    await page.screenshot({ path: info.outputPath('short-active-setup.png') });
    expect(fixture.errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('Simulation count distinguishes shown examples from a truncated recorded set', async ({ page }) => {
  const fixture = await prepare(page);
  try {
    const before = domain(fixture.db);
    await page.route(`**/api/extensions/${fixture.state.extension.id}/evidence/${fixture.state.evidence.id}`, async route => {
      const response = await route.fetch(), proof = await response.json();
      await route.fulfill({ response, json: { ...proof, summary: { ...proof.summary, truncated: true, totalCases: 6 } } });
    });
    await ui(page).locator('#studio-view-saved').click();
    await summary(page).getByRole('button', { name: 'View simulation', exact: true }).click();
    await expect(simulation(page).locator('.rs-simulation-heading')).toContainText('4 examples shown of 6 recorded');
    await expect(simulation(page)).toContainText('This summary is limited; 6 examples were recorded.');
    await expect(simulation(page)).not.toContainText('confirmed by you');
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('collapsed guard rows distinguish an expected unavailable check from a successful decision', async ({ page }, info) => {
  await page.setViewportSize({ width: 626, height: 900 });
  const fixture = await prepare(page, { fullGuardSuite: true });
  try {
    const before = domain(fixture.db);
    await ui(page).getByRole('button', { name: 'Simulation ↗', exact: true }).click();
    const decision = simulation(page), safety = decision.getByRole('article', { name: 'Example: Safety check: required check unavailable', exact: true });
    await expect(safety.locator('.rs-case-disclosure')).not.toHaveAttribute('open');
    await expect(safety.locator('.rs-case-overview')).toContainText('Required check deliberately unavailable');
    await expect(safety.locator('.rs-case-overview')).toContainText('Saving stopped as expected');
    await expect(safety.locator('.rs-case-support')).toBeHidden();
    await safety.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('expected-unavailable-collapsed.png') });
    await safety.locator('summary').first().click();
    await expect(safety.locator('.rs-case-support')).toContainText('The rule did not run');
    await expect(safety.locator('.rs-case-support')).toContainText('Expected');
    await expect(safety.locator('.rs-case-support')).toContainText('Observed');
    await page.screenshot({ path: info.outputPath('expected-unavailable-expanded.png') });
    await safety.locator('summary').first().click();
    await log(page).evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('eight-case-simulation.png') });
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

for (const proof of [true, false]) test(`top document return stays available on short screens (${proof ? 'expanded simulation' : 'long no-proof summary'})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 683, height: 384 });
  const fixture = await prepare(page, { proof });
  try {
    const before = domain(fixture.db), input = composer(page);
    await input.fill('Keep my short-screen draft.');
    await ui(page).locator('#studio-view-saved').click();
    await expect(summary(page)).toBeVisible();
    const back = ui(page).getByRole('button', { name: 'Back to conversation', exact: true });
    await expect(back).toHaveCount(1);
    await expect(back).toBeInViewport({ ratio: 1 });
    if (proof) {
      await summary(page).getByRole('button', { name: 'View simulation', exact: true }).click();
      await simulation(page).locator('.rs-case-overview').first().click();
      await expect(back).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: info.outputPath('top-document-return-short.png') });
    await back.click();
    await expect(summary(page)).toBeHidden(); await expect(simulation(page)).toBeHidden();
    await expect(input).toHaveValue('Keep my short-screen draft.');
    await expect(ui(page).locator('#studio-view-saved')).toBeFocused();
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

for (const prepend of [false, true]) test(`document return keeps its saved anchor across resize${prepend ? ' and an earlier-page arrival' : ''}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await prepare(page, { paged: prepend });
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    const before = domain(fixture.db), input = composer(page), transcript = log(page);
    await input.fill('Keep this exact draft across resize and history.');
    if (prepend) {
      await page.route('**/api/authoring/transcript?**', async route => {
        expect(new URL(route.request().url()).searchParams.get('before')).toBe('visual-older-page');
        arrived.resolve(); await release.promise;
        await route.fulfill({ json: { messages: Array.from({ length: 20 }, (_, index) => ({
          id: 'older-visual-' + index, conversationId: 'older-visual-conversation', role: 'assistant', kind: 'text',
          text: `Earlier explanation ${index}. ${'Retain the original discussion and its exact evidence. '.repeat(4)}`,
        })), next: null } });
      });
      await ui(page).getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await arrived.promise;
    }
    await transcript.evaluate(node => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; });
    const anchor = await transcript.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const message = [...node.querySelectorAll('.rs-message')].find(message => message.getBoundingClientRect().bottom > bounds.top && message.getBoundingClientRect().top < bounds.bottom);
      return { text: message.querySelector('p').textContent, offset: message.getBoundingClientRect().top - bounds.top,
        logTop: node.scrollTop, logHeight: node.clientHeight, logScrollHeight: node.scrollHeight };
    });
    const header = ui(page).locator('#studio-view-saved');
    await header.click();
    await expect(summary(page).getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    if (prepend) {
      release.resolve();
      await expect(ui(page).locator('[data-conversation-message]')).toHaveCount(28);
      await expect(summary(page)).toBeVisible();
      await expect(summary(page).getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
    }
    await page.screenshot({ path: info.outputPath('document-after-resize.png') });
    await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(header).toBeFocused();
    const retained = transcript.getByText(anchor.text, { exact: true }).locator('..');
    await expect(retained).toBeVisible();
    writeFileSync(info.outputPath('return-anchor-geometry.json'), JSON.stringify({ anchor, actual: await retained.evaluate(node => {
      const log = node.closest('[role="log"]');
      return { offset: node.getBoundingClientRect().top - log.getBoundingClientRect().top, logTop: log.scrollTop,
        logHeight: log.clientHeight, logScrollHeight: log.scrollHeight };
    }) }, null, 2));
    await page.screenshot({ path: info.outputPath('returned-anchor-after-resize.png') });
    await expect.poll(async () => Math.abs(await retained.evaluate(node => node.getBoundingClientRect().top
      - node.closest('[role="log"]').getBoundingClientRect().top) - anchor.offset)).toBeLessThanOrEqual(3);
    await expect(input).toHaveValue('Keep this exact draft across resize and history.');
    await expect(summary(page)).toBeHidden();
    await expect(simulation(page)).toBeHidden();
    await expect(input).toBeInViewport();
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]); expect(fixture.errors).toEqual([]);
  } finally { release.resolve(); await page.close(); await fixture.close(); }
});

for (const [name, viewport, coarse] of [
  ['desktop', { width: 1440, height: 900 }, false],
  ['short', { width: 1366, height: 600 }, false],
  ['narrow', { width: 390, height: 844 }, true],
  ['coarse-desktop', { width: 1280, height: 900 }, true],
]) test(`shared Daymark screens and dialogs stay coherent and usable on ${name}`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport, hasTouch: coarse });
  const page = await context.newPage();
  const fixture = await prepare(page);
  const navigate = async destination => {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: destination, exact: true }).click();
  };
  const metrics = {};
  const capture = async screen => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    metrics[screen] = await page.evaluate(() => {
      const style = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const css = getComputedStyle(node), box = node.getBoundingClientRect();
        return { background: css.backgroundColor, color: css.color, border: css.borderColor,
          radius: css.borderRadius, fontSize: css.fontSize, x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return Object.fromEntries(['.destinations', '.workspace-top', '.task-row', '.customization-card', '.rs-header', '.rs-composer',
        '.detail[open]', '.detail[open] input', '.detail[open] .primary'].map(selector => [selector, style(selector)]));
    });
    await page.screenshot({ path: info.outputPath(`${screen}.png`) });
  };
  try {
    const before = domain(fixture.db);
    const palette = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return Object.fromEntries(['--ink', '--muted', '--green', '--line', '--control'].map(key => [key, css.getPropertyValue(key).trim()]));
    });
    expect(palette).toEqual({ '--ink': '#192721', '--muted': '#5f6c64', '--green': '#355c49', '--line': '#dce1d9', '--control': '#858e83' });
    const luminance = hex => {
      const rgb = hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    expect(contrast('5f6c64', 'eaf1e8')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('355c49', 'ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('858e83', 'ffffff')).toBeGreaterThanOrEqual(3);
    await capture('studio-chat');
    await ui(page).getByRole('button', { name: 'Rename', exact: true }).click();
    await ui(page).getByRole('form', { name: 'Rename customization', exact: true }).getByLabel('Name', { exact: true }).fill('Keep this unsaved name');
    await capture('studio-rename');
    await ui(page).getByRole('form', { name: 'Rename customization', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(ui(page).getByRole('button', { name: 'Rename', exact: true })).toBeFocused();
    await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await capture('collection');
    await navigate('Tasks');
    await expect(page.locator('.task-row').first()).toBeVisible();
    await capture('tasks');
    for (const [selector, name] of [['.user-tools', 'account-tools'], ['.project-tools', 'project-tools'], ['.task-filter', 'tag-filter']]) {
      const tool = await openWorkspaceTool(page, selector), menu = tool.locator('.tool-menu-content');
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await capture(name);
      await tool.locator(':scope > summary').focus(); await page.keyboard.press('Escape');
      await expect(tool).toHaveJSProperty('open', false);
      await expect(tool.locator(':scope > summary')).toBeFocused();
    }
    const filter = await openWorkspaceTool(page, '.task-filter');
    await page.getByLabel('Filter by tag', { exact: true }).fill('review');
    await page.getByLabel('Filter by tag', { exact: true }).press('Enter');
    await expect(page.locator('.task-search-results [role="status"]')).not.toHaveText('Searching tasks…');
    await expect(filter).toHaveJSProperty('open', false);
    await expect(filter.locator(':scope > summary')).toBeFocused();
    await expect(page.locator('.task-applied-filters')).toBeVisible();
    await expect(page.locator('.task-applied-filters')).toContainText('Tag “review”');
    await capture('active-tag-filter-closed');
    await openWorkspaceTool(page, '.task-filter');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(filter).toHaveJSProperty('open', false);
    await expect(page.getByLabel('Search tasks', { exact: true })).toBeFocused();
    await expect(page.locator('.task-applied-filters')).toHaveCount(0);
    if (coarse) for (const target of await page.locator('.completion, .quick-add button, .user-tools > summary').all()) {
      const box = await target.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByLabel('New task title', { exact: true }).fill('Keep this new task draft');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue('Keep this new task draft');
    await dialog.getByLabel('Notes (optional)', { exact: true }).fill('Keep these notes');
    await capture('new-task');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('New task title', { exact: true })).toHaveValue('Keep this new task draft');
    await page.locator('.quick-add').getByRole('button', { name: 'Details', exact: true }).click();
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue('Keep this new task draft');
    await expect(dialog.getByLabel('Notes (optional)', { exact: true })).toHaveValue('Keep these notes');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Keep this detail draft');
    await capture('task-detail');
    await expect(page.locator('#open-customizations')).toHaveCount(0);
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this detail draft');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Gather material references', exact: true })).toBeFocused();
    await navigate('Customizations');
    await page.locator(`[id="edit-${fixture.state.extension.id}"]`).click();
    await page.unroute('**/api/authoring**');
    await ui(page).getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    await ui(page).getByRole('region', { name: 'Assistant setup', exact: true }).getByRole('button', { name: 'Configure', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
    await expect(setup.getByLabel('Service', { exact: true })).toBeVisible();
    await capture('assistant-setup');
    const cancel = setup.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.scrollIntoViewIfNeeded(); await expect(cancel).toBeInViewport();
    await cancel.click();
    expect(domain(fixture.db)).toEqual(before);
    expect(fixture.posted).toEqual([]); expect(fixture.requests).toEqual([]); expect(fixture.errors).toEqual([]);
    writeFileSync(info.outputPath('shared-geometry.json'), JSON.stringify(metrics, null, 2) + '\n');
  } finally { await context.close(); await fixture.close(); }
});
