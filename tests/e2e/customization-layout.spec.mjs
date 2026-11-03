import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'daymark-layout-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const server = await start({ directory, port });
    try { await use(server); }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
const ui = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
async function appLockup(page) {
  const brand = page.locator('.brand').filter({ visible: true });
  await expect(brand).toHaveCount(1);
  await expect(brand.locator('.brand-name')).toHaveText('Daymark');
  await expect(brand.locator('.brand-subline')).toHaveText('A KEIR Demo');
  const name = await brand.locator('.brand-name').boundingBox(), subline = await brand.locator('.brand-subline').boundingBox();
  expect(subline.y).toBeGreaterThanOrEqual(name.y + name.height);
  expect(subline.y - name.y - name.height).toBeLessThan(8);
  expect(Math.abs(subline.x - name.x)).toBeLessThanOrEqual(1);
  await expect(page.getByText('Powered by Keir', { exact: true })).toHaveCount(0);
}
async function openDetails(page) {
  if (await ui(page).locator('.rs-preview').isHidden()) {
    await ui(page).getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(ui(page).locator('.rs-tools')).toHaveJSProperty('open', true);
    return;
  }
  const collapsed = ui(page).locator('details.rs-tools:not([open]) > summary');
  if (await collapsed.count()) await collapsed.click();
}
async function studioAction(page, name) {
  await openDetails(page);
  return ui(page).getByRole('button', { name, exact: true });
}
async function openExampleDetails(results) {
  const summary = results.getByText('About these examples', { exact: true });
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
}
async function enter(page, demo) {
  await page.goto(demo.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible();
}
async function destination(page, name) {
  if (page.viewportSize().width <= 760) await page.getByLabel('Destination', { exact: true }).selectOption(name.toLowerCase());
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
}
async function overview(page) {
  await destination(page, 'Customizations');
  await expect(page.getByRole('article', { name: 'Task advice customization' })).toBeVisible();
}
async function openStudio(page, inspect = true) {
  await overview(page);
  await page.locator('#edit-task-advice').click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(ui(page).getByLabel('Message to Studio')).toBeVisible();
  if (inspect && page.viewportSize().width > 1120 && page.viewportSize().height > 650) {
    await expect(await studioAction(page, 'View proposal')).toBeEnabled();
    await (await studioAction(page, 'View proposal')).click();
  }
}
async function picture(page, name) {
  mkdirSync(resolve('build/screens'), { recursive: true });
  await page.screenshot({ path: resolve('build/screens', `daymark-${name}.png`), fullPage: true });
}
async function prepareChoice(page, label) {
  const previewWasOpen = await ui(page).locator('.rs-preview').isVisible();
  const saved = await savedState(page);
  const templateId = label === 'Pending' ? 'pending' : 'attention';
  const result = await page.evaluate(async ({ templateId, draftVersion }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/extensions/draft', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken },
      body: JSON.stringify({ templateId, draftVersion }) });
    return { ok: response.ok, state: response.ok ? await response.json() : null };
  }, { templateId, draftVersion: saved.draftVersion });
  expect(result.ok).toBeTruthy();
  const reload = ui(page).getByRole('button', { name: 'Reload saved state', exact: true });
  if (!await reload.isVisible()) {
    const manage = ui(page).getByRole('button', { name: 'Manage', exact: true });
    if (await manage.isVisible()) await manage.click();
    else {
      await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await page.locator('#edit-task-advice').click();
      await ui(page).getByRole('button', { name: 'Manage', exact: true }).click();
    }
  }
  await reload.click();
  await expect(reload).toBeEnabled();
  await expect.poll(async () => (await savedState(page)).draft?.templateId).toBe(templateId);
  if (!previewWasOpen) await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
}
async function choose(page, label) {
  await prepareChoice(page, label);
}
async function scrollTop(locator) { return locator.evaluate(node => node.scrollTop); }
async function pageDown(page, locator) {
  await locator.focus();
  const before = await scrollTop(locator);
  // Arm on keydown so completion belongs to this key, not the preceding wheel.
  const scroll = await locator.evaluateHandle(node => ({ ended: new Promise(resolve => {
    node.addEventListener('keydown', () => {
      node.addEventListener('scrollend', () => resolve(node.scrollTop), { once: true });
    }, { once: true });
  }) }));
  try {
    await page.keyboard.press('PageDown');
    const position = await scroll.evaluate(state => state.ended);
    expect(position).toBeGreaterThan(before);
    return position;
  } finally { await scroll.dispose(); }
}
async function wheel(page, locator, delta) {
  const target = await locator.evaluate((node, amount) => Math.max(0, Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + amount)), delta);
  const box = await locator.boundingBox();
  await locator.hover({ position: { x: 6, y: box.height / 2 } }); await page.mouse.wheel(0, delta);
  // Scroll metrics round fractional pane heights differently by one pixel.
  await expect.poll(async () => Math.abs(await scrollTop(locator) - target)).toBeLessThanOrEqual(1);
}
async function bounded(page) {
  expect(await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight })))
    .toEqual({ x: false, y: 0, height: page.viewportSize().height, viewport: page.viewportSize().height });
}

async function savedState(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await fetch('/api/extensions', { headers: { 'X-Session-Context': session.contextToken } })).json();
  });
}

// Script the public authoring protocol for layout behavior; this does not qualify a provider or authoring backend.
async function scriptLayoutAuthoring(page) {
  const state = await savedState(page);
  const calls = { turns: [] };
  let current = null, creationOperationId = null;
  const availability = { available: true, code: null, provider: 'openai', model: 'gpt-5.6-terra' };
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/authoring' && method === 'GET') {
      return send({ availability, conversations: current ? [{ id: current.id, version: current.version, status: current.status,
        runId: current.runId, creationOperationId, operationId: current.operation.id }] : [], current });
    }
    const match = url.pathname.match(/^\/api\/authoring\/conversations\/([^/]+)$/);
    if (match && method === 'GET') return current?.id === match[1] ? send(current) : send({ message: 'Unknown conversation' }, 404);
    if (url.pathname === '/api/authoring/turn' && method === 'POST') {
      const body = request.postDataJSON();
      calls.turns.push(body);
      const version = body.expectedVersion + 1;
      const runId = `layout-run-${version}`;
      current = { id: body.conversationId ?? 'layout-conversation', version, status: 'AWAITING_USER', runId,
        operation: { id: body.operationId, runId, version }, messages: [
          ...(current?.messages ?? []),
          { id: `layout-user-${version}`, role: 'user', text: body.text, kind: 'text' },
          { id: `layout-assistant-${version}`, role: 'assistant', text: `Saved scripted response ${version}. What should I clarify?`, kind: 'clarification' },
        ], code: null, review: null, draft: { revisionId: state.draft?.id ?? null, draftVersion: body.expectedDraftVersion, suiteDigest: null },
        selection: { revisionId: state.selection.revision?.id ?? null, generation: state.selection.generation } };
      if (!creationOperationId) creationOperationId = body.operationId;
      return send({ operation: current.operation, conversation: current }, 202);
    }
    return send({ message: 'Unexpected scripted authoring request' }, 404);
  });
  return calls;
}

test('general start opens the chat without choices and distinguishes untouched from off setups with history', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await page.getByRole('button', { name: 'Continue as Sam' }).click();
  await destination(page, 'Customizations');
  await expect(page.getByText('You have no saved customizations.', { exact: false })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Task advice customization' })).toHaveCount(0);
  const before = await savedState(page);
  let mutations = 0;
  page.on('request', request => { if (request.method() === 'POST' && (request.url().includes('/api/extensions/') || request.url().includes('/api/authoring'))) mutations++; });
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByRole('heading', { name: 'What would you like to change about your work?' })).toBeVisible();
  await expect(ui(page).getByLabel('Message to Studio')).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'See available starting points', exact: true })).toHaveCount(0);
  await expect(ui(page).getByRole('button', { name: /Pending for open tasks|Needs attention for open tasks/ })).toHaveCount(0);
  await expect(ui(page).getByRole('button', { name: 'Change choice', exact: true })).toHaveCount(0);
  await expect(ui(page).getByText('Developer qualification · authored source', { exact: true })).toHaveCount(0);
  await expect(ui(page).getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
  await expect(ui(page).getByText('Set up the assistant to create or change a customization.', { exact: true })).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
  await picture(page, 'general-start');
  expect(await savedState(page)).toEqual(before);
  expect(mutations).toBe(0);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeFocused();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('maya');
  await openStudio(page);
  await ui(page).getByRole('button', { name: 'Manage', exact: true }).click();
  await ui(page).getByText('Manage saved advice', { exact: true }).click();
  await ui(page).getByRole('button', { name: 'Turn off my advice' }).click();
  const off = await savedState(page);
  expect(off.draft).toBeNull(); expect(off.history.length).toBeGreaterThan(0);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(page.getByRole('article', { name: 'Task advice customization' })).toContainText('Off');
  await picture(page, 'general-off');
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Studio')).toBeVisible();
  expect(await savedState(page)).toEqual(off);
});

test('saved draft resumes in chat and failed saved-state reads offer Retry', async ({ page, demo }) => {
  await enter(page, demo); await overview(page);
  const initial = await savedState(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Studio')).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'See available starting points', exact: true })).toHaveCount(0);
  expect(await savedState(page)).toEqual(initial);
  await prepareChoice(page, 'Needs attention');
  const draft = await savedState(page);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(page.locator('#edit-task-advice')).toContainText('Continue draft');
  await destination(page, 'Tasks');
  await page.route('**/api/extensions', route => route.abort('failed'));
  await destination(page, 'Customizations');
  await expect(page.getByRole('alert')).toContainText('Customizations could not be checked');
  await expect(page.getByText('You have no saved customizations.', { exact: false })).toHaveCount(0);
  await page.unroute('**/api/extensions');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue draft', exact: true })).toBeEnabled();
  await picture(page, 'discovery-continue');
  await page.locator('#edit-task-advice').click();
  await ui(page).getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'Reload saved state', exact: true })).toBeEnabled();
  expect(await savedState(page)).toEqual(draft);
});

test('approved run stays exact after a newer run and remount until explicit reapproval', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page, false);
  const studio = ui(page);
  await prepareChoice(page, 'Needs attention');
  expect((await savedState(page)).draft.templateId).toBe('attention');
  await picture(page, 'conversation-default');
  await (await studioAction(page, 'Try on sample tasks')).click();
  await expect(await studioAction(page, 'Latest run')).toBeEnabled();
  await expect(studio.locator('.rs-preview')).toBeVisible();
  await (await studioAction(page, 'Latest run')).click();
  await expect(studio.getByRole('heading', { name: 'The examples match', exact: true })).toBeVisible();
  await studio.getByRole('button', { name: 'Review this advice', exact: true }).click();
  await studio.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await studio.getByRole('button', { name: 'This is what I want', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeFocused();
  const approved = await savedState(page);
  const a = approved.approvedEvidenceId;
  expect(a).toBe(approved.evidence.id);
  await expect(studio.locator('.rs-preview')).toBeHidden();
  await (await studioAction(page, 'Try on sample tasks')).click();
  await expect.poll(async () => (await savedState(page)).evidence.id).not.toBe(a);
  await expect(studio.getByRole('button', { name: 'Latest run', exact: true })).toBeEnabled();
  const b = (await savedState(page)).evidence.id;
  expect((await savedState(page)).approvedEvidenceId).toBe(a);
  await page.reload(); await openStudio(page, false);
  await (await studioAction(page, 'Approved run')).click();
  const results = studio.getByRole('article', { name: 'Sample results', exact: true });
  await results.getByText('Saved run identity', { exact: true }).click();
  await expect(results).toContainText(`Evidence: ${a}`);
  await openExampleDetails(results);
  await expect(results.getByText('Approved run', { exact: true })).toBeVisible();
  await (await studioAction(page, 'Latest run')).click();
  await expect(results).toContainText(`Evidence: ${b}`);
  await openExampleDetails(results);
  await expect(results.getByText('Latest run', { exact: true })).toBeVisible();
  await expect(results.getByText('Approved run', { exact: true })).toHaveCount(0);
  await picture(page, 'approved-latest');
  await studio.getByRole('button', { name: 'Review this advice', exact: true }).click();
  await studio.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await expect(studio.getByRole('button', { name: 'This is what I want', exact: true })).toBeEnabled();
  await studio.getByRole('button', { name: 'This is what I want', exact: true }).click();
  await expect.poll(async () => (await savedState(page)).approvedEvidenceId).toBe(b);
  expect((await savedState(page)).selection.revision.templateId).toBe('pending');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 683, height: 384 }]) {
test(`approved reentry ${viewport.width}x${viewport.height} resumes the saved decision with Use in view`, async ({ page, demo }) => {
  await page.setViewportSize(viewport);
  await enter(page, demo); await openStudio(page, false);
  const studio = ui(page);
  await choose(page, 'Needs attention');
  await (await studioAction(page, 'Try on sample tasks')).click();
  await (await studioAction(page, 'Latest run')).click();
  await expect(studio.getByRole('heading', { name: 'The examples match', exact: true })).toBeVisible();
  await studio.getByRole('button', { name: 'Review this advice', exact: true }).click();
  await studio.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await studio.getByRole('button', { name: 'This is what I want', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Turn on for my tasks' })).toBeFocused();
  await studio.getByRole('button', { name: 'Back to Customizations' }).click();
  await page.locator('#edit-task-advice').click();
  await expect(await studioAction(page, 'View proposal')).toBeEnabled();
  await expect(studio.getByRole('button', { name: 'Turn on for my tasks' })).toBeInViewport();
  await expect(studio.getByLabel('Customization status')).toContainText('Approved · Needs attention');
  await expect(studio.getByRole('button', { name: /Pending for open tasks|Needs attention for open tasks/ })).toHaveCount(0);
  expect((await savedState(page)).selection.revision.templateId).toBe('pending');
  await picture(page, `approved-resume-${viewport.width}x${viewport.height}`);
  await studio.getByRole('button', { name: 'Turn on for my tasks' }).click();
  const completion = studio.getByRole('article', { name: 'Advice is on' });
  await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeVisible();
  await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeFocused();
  await expect.poll(async () => (await savedState(page)).selection.revision.templateId).toBe('attention');
});
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
test(`deliberate review ${viewport.width}x${viewport.height} retains evidence reading composer width and focus while closed`, async ({ page, demo }) => {
  await page.setViewportSize(viewport);
  await enter(page, demo); await openStudio(page, false);
  const studio = ui(page), composer = studio.getByLabel('Message to Studio');
  await expect(studio.locator('.rs-preview')).toBeHidden();
  await expect(studio.getByRole('separator')).toHaveCount(0);
  await prepareChoice(page, 'Needs attention');
  await composer.fill('Keep this unsent thought');
  const run = await studioAction(page, 'Try on sample tasks');
  await run.click();
  await expect(await studioAction(page, 'Latest run')).toBeEnabled();
  await expect(studio.getByRole('status')).toContainText('A new sample run was saved.');
  let latest = await studioAction(page, 'Latest run');
  await latest.click();
  await expect(studio.getByRole('heading', { name: 'The examples match' })).toBeFocused();
  const divider = studio.getByRole('separator'), canvas = studio.locator('.rs-canvas');
  if (viewport.height <= 500) {
    const example = studio.locator('.rs-example').first();
    expect(await canvas.evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(await example.evaluate(node => node.getBoundingClientRect().height));
    await example.scrollIntoViewIfNeeded();
    await expect(example).toBeInViewport({ ratio: 1 });
    await picture(page, `on-demand-example-${viewport.width}x${viewport.height}`);
  }
  let width;
  if (viewport.width > 1120 && viewport.height > 650) {
    await divider.focus(); await divider.press('End');
    width = await divider.getAttribute('aria-valuenow');
  } else await expect(divider).toHaveCount(0);
  await wheel(page, canvas, 220);
  const position = await scrollTop(canvas), id = (await savedState(page)).evidence.id;
  await studio.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(studio.getByRole('button', { name: 'Manage', exact: true })).toBeFocused();
  await expect(studio.locator('.rs-preview')).toBeHidden();
  await expect(studio.getByRole('separator')).toHaveCount(0);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.rs-preview'))).toBe(false);
  latest = await studioAction(page, 'Latest run');
  await latest.click();
  await expect(studio.locator('.rs-preview')).toBeVisible();
  await expect(studio.getByRole('heading', { name: 'The examples match' })).toBeFocused();
  await expect.poll(() => scrollTop(canvas)).toBe(position);
  if (width) await expect(divider).toHaveAttribute('aria-valuenow', width);
  await expect(composer).toHaveValue('Keep this unsent thought');
  await studio.getByText('Saved run identity', { exact: true }).click();
  const results = studio.getByRole('article', { name: 'Sample results' });
  await expect(results).toContainText(`Evidence: ${id}`);
  await openExampleDetails(results);
  await expect(results.getByText('These are synthetic sample tasks, not live task changes.', { exact: false })).toBeVisible();
  await bounded(page);
  await picture(page, `on-demand-results-${viewport.width}x${viewport.height}`);
});
}

test('normal navigation preserves native forms and returns to the actual overview or detail invoker', async ({ page, demo }) => {
  await enter(page, demo);
  await expect(page).toHaveTitle('Daymark — tasks and customizations');
  await page.getByLabel('New task title').fill('Keep my quick-add');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill('Keep this project draft');
  await openStudio(page);
  await expect(page.locator('.project-link.selected')).toHaveCount(0);
  await appLockup(page);
  await expect(ui(page).getByRole('heading', { level: 1 })).toHaveText('Studio');
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(page.locator('#edit-task-advice')).toBeFocused();
  await destination(page, 'Tasks');
  await expect(page.locator('.project-link.selected')).toHaveCount(1);
  await expect(page.getByLabel('New task title')).toHaveValue('Keep my quick-add');
  await expect(page.getByLabel('New project name', { exact: true })).toHaveValue('Keep this project draft');
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Keep native detail title');
  await page.getByLabel('Notes (optional)').fill('Keep native detail notes');
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(ui(page).getByRole('heading', { level: 1 })).toBeVisible();
  await ui(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage task advice', exact: true })).toBeFocused();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep native detail title');
  await expect(page.getByLabel('Notes (optional)')).toHaveValue('Keep native detail notes');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Gather material references', exact: true })).toBeFocused();
});

test('overview reflects real draft, approved, selected, off and unavailable states without a task-specific entry', async ({ page, demo }) => {
  await page.goto(demo.origin); await appLockup(page); await picture(page, 'welcome');
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible();
  await appLockup(page);
  await picture(page, 'tasks');
  await openStudio(page); await picture(page, 'studio-current');
  await choose(page, 'Needs attention');
  await picture(page, 'studio-draft');
  await (await studioAction(page, 'Try on sample tasks')).click();
  await (await studioAction(page, 'Latest run')).click();
  await expect(ui(page).locator('.rs-example')).toHaveCount(6);
  await picture(page, 'studio-results');
  await ui(page).getByRole('button', { name: 'Review this advice', exact: true }).click();
  await picture(page, 'studio-review');
  await ui(page).getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await ui(page).getByRole('button', { name: 'This is what I want', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeFocused();
  await expect(ui(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeInViewport();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  const card = page.getByRole('article', { name: 'Task advice customization' });
  await expect(card).toContainText('Approved · awaiting use: Needs attention');
  await expect(card).toContainText('Open tasks: Pending');
  await page.locator('#edit-task-advice').click();
  await ui(page).getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(card).toContainText('Current choice: Needs attention');
  await expect(card).not.toContainText('awaiting use');
  await picture(page, 'overview-in-use');
  demo.db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya')").run();
  await destination(page, 'Tasks'); await overview(page);
  await expect(card).toContainText('Unavailable');
  await expect(card).not.toContainText('completed tasks: Done');
  await picture(page, 'overview-unavailable');
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam'); await destination(page, 'Customizations');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Studio')).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'See available starting points', exact: true })).toHaveCount(0);
  expect((await savedState(page)).selection.revision).toBeNull();
  expect((await savedState(page)).draft).toBeNull();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(card).toHaveCount(0);
  await picture(page, 'overview-off');
});

test('overflowing native projects and tasks scroll independently with stable navigation and retained task position', async ({ page, demo }) => {
  const now = new Date().toISOString();
  for (let i = 0; i < 60; i++) demo.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(`overflow-project-${i}`, 'maya', `Overflow project ${i}`, now, now);
  const project = demo.db.prepare("SELECT id FROM projects WHERE owner_id='maya' ORDER BY created_at LIMIT 1").get().id;
  for (let i = 0; i < 80; i++) demo.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`overflow-task-${i}`, 'maya', project, `Overflow task ${i}`, '', 'open', now, now, null);
  await enter(page, demo);
  const rail = page.locator('.rail'), header = page.locator('.workspace-top'), main = page.locator('.task-main'), projects = page.getByRole('navigation', { name: 'Projects' });
  const geometry = { rail: await rail.boundingBox(), header: await header.boundingBox() };
  await wheel(page, main, 600); await expect.poll(() => scrollTop(main)).toBeGreaterThan(200);
  await expect.poll(() => scrollTop(projects)).toBe(0);
  expect(await rail.boundingBox()).toEqual(geometry.rail); expect(await header.boundingBox()).toEqual(geometry.header);
  const taskPosition = await pageDown(page, main);
  await wheel(page, projects, 500); await expect.poll(() => scrollTop(projects)).toBeGreaterThan(200);
  expect(await scrollTop(main)).toBe(taskPosition);
  await projects.evaluate(node => node.scrollTop = node.scrollHeight); await wheel(page, projects, 600);
  expect(await scrollTop(main)).toBe(taskPosition); await bounded(page);
  await overview(page); await destination(page, 'Tasks');
  expect(await scrollTop(main)).toBe(taskPosition);
  await picture(page, 'native-overflow');
});

test('transcript and canvas own wheel and PageDown; arrivals preserve earlier reading and splitter keeps usable widths', async ({ page, demo }) => {
  await enter(page, demo); const authoringFixture = await scriptLayoutAuthoring(page); await openStudio(page);
  const log = ui(page).getByRole('log'), canvas = ui(page).locator('.rs-canvas'), composer = ui(page).locator('.rs-composer');
  const header = page.locator('.workspace-top'), rail = page.locator('.rail');
  for (let i = 0; i < 13; i++) {
    await ui(page).getByLabel('Message to Studio').fill(`Message ${i}: ${'Please explain this example. '.repeat(10)}`);
    await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
  }
  expect(authoringFixture.turns).toHaveLength(13);
  await expect(log.locator('article')).toHaveCount(27);
  await log.evaluate(node => node.scrollTop = 0);
  const geometry = { composer: await composer.boundingBox(), header: await header.boundingBox(), rail: await rail.boundingBox() };
  await wheel(page, log, 400); await expect.poll(() => scrollTop(log)).toBeGreaterThan(100);
  expect(await scrollTop(canvas)).toBe(0);
  await pageDown(page, log);
  await log.evaluate(node => node.scrollTop = 0);
  await ui(page).getByLabel('Message to Studio').fill('A new message while reading earlier replies');
  await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
  expect(authoringFixture.turns).toHaveLength(14);
  expect(await scrollTop(log)).toBe(0);
  await openDetails(page);
  await ui(page).getByText('Manage saved advice', { exact: true }).click();
  await ui(page).getByText('Selection history and exact identities', { exact: true }).click();
  await wheel(page, canvas, 120); await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(50);
  expect(await scrollTop(log)).toBe(0);
  await pageDown(page, canvas);
  await canvas.evaluate(node => node.scrollTop = node.scrollHeight); await wheel(page, canvas, 600);
  expect(await scrollTop(log)).toBe(0);
  expect(await composer.boundingBox()).toEqual(geometry.composer); expect(await header.boundingBox()).toEqual(geometry.header); expect(await rail.boundingBox()).toEqual(geometry.rail);
  const divider = ui(page).getByRole('separator');
  for (const key of ['Home', 'ArrowRight', 'End', 'ArrowLeft']) { await divider.focus(); await divider.press(key); }
  expect((await ui(page).locator('.rs-chat').boundingBox()).width).toBeGreaterThanOrEqual(300);
  expect((await ui(page).locator('.rs-preview').boundingBox()).width).toBeGreaterThanOrEqual(340);
  await divider.press('Home'); await expect(divider).toHaveAttribute('aria-valuenow', await divider.getAttribute('aria-valuemin'));
  await divider.press('End'); await expect(divider).toHaveAttribute('aria-valuenow', await divider.getAttribute('aria-valuemax'));
  await bounded(page); await picture(page, 'studio-history-overflow');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 900, height: 500 }, { width: 360, height: 540 }, { width: 683, height: 384 }]) {
  test(`narrow/short ${viewport.width}x${viewport.height} has direct entry, retained panes/composer and keyboard-reachable actions`, async ({ page, demo }) => {
    await page.setViewportSize(viewport); await enter(page, demo); const authoringFixture = await scriptLayoutAuthoring(page); await openStudio(page); await appLockup(page);
    const studio = ui(page), log = studio.getByRole('log'), composer = studio.getByLabel('Message to Studio');
    await composer.fill('Keep this unsent message');
    const composerBox = await studio.locator('.rs-composer').boundingBox();
    expect(composerBox.bottom ?? composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height);
    for (let i = 0; i < 5; i++) {
      await composer.fill(`Long example ${i} ${'explain this task '.repeat(14)}`); await studio.getByRole('button', { name: 'Send', exact: true }).click();
    }
    expect(authoringFixture.turns).toHaveLength(5);
    await composer.fill('Keep this unsent message');
    await log.evaluate(node => node.scrollTop = 0); await wheel(page, log, 300);
    await expect.poll(() => scrollTop(log)).toBeGreaterThan(0);
    const logPosition = await scrollTop(log);
    await picture(page, `studio-conversation-${viewport.width}x${viewport.height}`);
    await (await studioAction(page, 'View proposal')).click();
    await expect(studio.locator('.rs-chat')).toBeHidden();
    await openDetails(page);
    await studio.getByText('Manage saved advice', { exact: true }).click();
    await studio.getByText('Selection history and exact identities', { exact: true }).click();
    const canvas = studio.locator('.rs-canvas'); await wheel(page, canvas, 300);
    await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(0); const canvasPosition = await scrollTop(canvas);
    await studio.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(composer).toHaveValue('Keep this unsent message'); expect(await scrollTop(log)).toBe(logPosition);
    await (await studioAction(page, 'View proposal')).click(); await expect.poll(() => scrollTop(canvas)).toBe(canvasPosition);
    await canvas.focus(); await page.keyboard.press('PageDown');
    await openDetails(page);
    await studio.getByRole('button', { name: 'Reload saved state', exact: true }).focus();
    await page.keyboard.press('Tab');
    await bounded(page); await picture(page, `studio-${viewport.width}x${viewport.height}`);
    await studio.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await expect(page.locator('#edit-task-advice')).toBeFocused();
  });
}

test('late overview and Studio reads cannot repopulate an abandoned destination or an away-and-back owner', async ({ page, demo }) => {
  await enter(page, demo);
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions', async route => {
    const response = await route.fetch(); arrived(); await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* Abandoned owner requests may already be aborted. */ }
    delivered();
  });
  try {
    await destination(page, 'Customizations'); await started;
    await destination(page, 'Tasks'); await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('heading', { name: 'Neighbourhood workshop', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('maya');
    release(); await finished; await page.unroute('**/api/extensions');
    await expect(page.getByRole('article', { name: 'Task advice customization' })).toHaveCount(0);
    await overview(page); await expect(page.getByRole('article', { name: 'Task advice customization' })).toContainText('Read-only advice for Maya');
    await page.locator('#edit-task-advice').click();
    await expect.poll(async () => (await savedState(page)).owner.id).toBe('maya');
    await expect(ui(page).getByRole('button', { name: /Pending for open tasks|Needs attention for open tasks/ })).toHaveCount(0);
    let releaseStudio, arrivedStudio;
    const studioStarted = new Promise(resolve => { arrivedStudio = resolve; });
    await page.route('**/api/extensions', async route => { const response = await route.fetch(); arrivedStudio(); await new Promise(resolve => { releaseStudio = resolve; }); try { await route.fulfill({ response }); } catch {} });
    await openDetails(page);
    await ui(page).getByRole('button', { name: 'Reload saved state', exact: true }).click(); await studioStarted;
    await destination(page, 'Tasks'); await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    releaseStudio(); await page.unroute('**/api/extensions');
    await openStudio(page);
    await expect.poll(async () => (await savedState(page)).owner.id).toBe('leo');
    await expect(ui(page).getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
    await expect(ui(page).getByRole('heading', { name: 'Pending', exact: true })).toHaveCount(0);
  } finally { release?.(); }
});

test('a newly produced real sample run does not replace historical evidence being read', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page);
  const studio = ui(page);
  await choose(page, 'Needs attention');
  await (await studioAction(page, 'Try on sample tasks')).click();
  await (await studioAction(page, 'Latest run')).click();
  await expect(studio.getByRole('heading', { name: 'The examples match', exact: true })).toBeVisible();
  const original = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await (await fetch('/api/extensions', { headers: { 'X-Session-Context': session.contextToken } })).json()).evidence.id;
  });
  await choose(page, 'Pending');
  let simulationRequests = 0;
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions/simulate', async route => {
    simulationRequests++;
    const response = await route.fetch();
    expect((await response.json()).evidence.id).not.toBe(original);
    arrived(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }); delivered();
  });
  try {
    await (await studioAction(page, 'Try on sample tasks')).click(); await started;
    await (await studioAction(page, 'Examples')).click();
    const results = studio.getByRole('article', { name: 'Sample results', exact: true });
    const content = await results.locator('[aria-label="Expected and actual sample results"]').textContent();
    await results.getByText('Saved run identity', { exact: true }).click();
    await expect(results).toContainText(`Evidence: ${original}`);
    const canvas = studio.locator('.rs-canvas'); await wheel(page, canvas, 400); const position = await scrollTop(canvas);
    await expect(await studioAction(page, 'Try on sample tasks')).toBeDisabled();
    await (await studioAction(page, 'Try on sample tasks')).click({ force: true });
    expect(simulationRequests).toBe(1);
    release(); await finished;
    await expect(await studioAction(page, 'Try on sample tasks')).toBeEnabled();
    await expect(studio.getByRole('status')).toContainText('A new sample run was saved.');
    expect(await results.locator('[aria-label="Expected and actual sample results"]').textContent()).toBe(content);
    await expect(results).toContainText(`Evidence: ${original}`);
    expect(await scrollTop(canvas)).toBe(position);
    await studio.getByRole('button', { name: 'Current advice', exact: true }).click();
    await studio.getByRole('button', { name: 'Open current sample results', exact: true }).click();
    await expect(results).toContainText('Saved sample run · Current proposal');
    expect(await results.locator('[aria-label="Expected and actual sample results"]').textContent()).not.toBe(content);
  } finally { release?.(); }
});

for (const operation of ['simulate', 'approve', 'activate']) {
  test(`an already-produced ${operation} response preserves explicitly selected sample reading`, async ({ page, demo }) => {
    await enter(page, demo); await openStudio(page);
    const studio = ui(page);
    await prepareChoice(page, 'Needs attention');
    await (await studioAction(page, 'Try on sample tasks')).click();
    await (await studioAction(page, 'Latest run')).click();
    await expect(studio.getByRole('heading', { name: 'The examples match', exact: true })).toBeVisible();
    const original = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      return (await fetch('/api/extensions', { headers: { 'X-Session-Context': session.contextToken } })).json();
    });
    if (operation !== 'simulate') {
      await studio.getByRole('button', { name: 'Review this advice', exact: true }).click();
      await studio.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
      if (operation === 'activate') await studio.getByRole('button', { name: 'This is what I want', exact: true }).click();
    }
    let release, arrived, delivered;
    const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
    await page.route(`**/api/extensions/${operation}`, async route => {
      const response = await route.fetch();
      const saved = await response.json();
      if (operation === 'simulate') {
        expect(saved.selection.generation).toBe(original.selection.generation);
        expect(saved.draft.id).toBe(original.draft.id);
        expect(saved.draftVersion).toBe(original.draftVersion);
        expect(saved.evidence.id).not.toBe(original.evidence.id);
      } else {
        expect(saved.draft.id).toBe(original.draft.id);
        expect(saved.evidence.id).toBe(original.evidence.id);
        expect(saved.approved).toBe(true);
        if (operation === 'approve') expect(saved.selection.generation).toBe(original.selection.generation);
        else {
          expect(saved.selection.generation).toBe(original.selection.generation + 1);
          expect(saved.selection.revision.id).toBe(original.draft.id);
        }
      }
      arrived(); await new Promise(resolve => { release = resolve; });
      await route.fulfill({ response }); delivered();
    });
    try {
      if (operation === 'simulate') await (await studioAction(page, 'Try on sample tasks')).click();
      else if (operation === 'approve') await studio.getByRole('button', { name: 'This is what I want', exact: true }).click();
      else await studio.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
      await started;
      if (operation !== 'simulate') await (await studioAction(page, 'View proposal')).click();
      const tab = studio.getByRole('button', { name: 'Examples', exact: true });
      await tab.click();
      const results = studio.getByRole('article', { name: 'Sample results', exact: true });
      await results.getByText('Saved run identity', { exact: true }).click();
      const content = await results.locator('[aria-label="Expected and actual sample results"]').textContent();
      const canvas = studio.locator('.rs-canvas');
      await canvas.evaluate(node => node.scrollTop = 0);
      await canvas.focus(); await wheel(page, canvas, 200);
      const anchor = results.locator('.rs-example').nth(2);
      await expect(anchor).toBeInViewport();
      const position = (await anchor.boundingBox()).y;
      release(); await finished;
      await expect(studio.getByRole('button', { name: 'Change choice', exact: true })).toHaveCount(0);
      await expect(tab).toHaveAttribute('aria-pressed', 'true');
      await expect(results).toBeVisible();
      await expect(results).toContainText(`Evidence: ${original.evidence.id}`);
      expect(await results.locator('[aria-label="Expected and actual sample results"]').textContent()).toBe(content);
      await expect(canvas).toBeFocused();
      expect(await scrollTop(canvas)).toBeGreaterThan(0);
      expect(Math.abs((await anchor.boundingBox()).y - position)).toBeLessThanOrEqual(1);
      await openExampleDetails(results);
      await expect(results).toContainText(operation === 'simulate' ? 'Earlier run for current proposal' : 'Current proposal');
      if (operation === 'simulate') await expect(results.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
      else await expect(results.getByRole('button', { name: 'Review this advice', exact: true })).toBeEnabled();
      await expect(studio.getByRole('button', { name: 'This is what I want', exact: true })).toHaveCount(0);
    } finally { release?.(); }
  });
}
