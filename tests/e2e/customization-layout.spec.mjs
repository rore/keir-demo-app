import { test as base, expect } from '@playwright/test';
import { openDeveloperTools, openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { taskService } from '../../src/data.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

const originalLabel = 'Review follow-up', proposedLabel = 'Prepare next step';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'daymark-layout-'));
    const reservation = createServer();
    await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const server = await start({ directory, port, staticRoot: resolve(process.env.LAYOUT_STATIC_ROOT ?? 'dist') });
    try {
      const lifecycle = createLifecycle(server.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
      const initial = {};
      for (const owner of ['maya', 'leo']) {
        const project = taskService(server.db).listProjects(owner)[0];
        const fixture = taskCustomizationFixture({ projectId: project.id, otherProjectId: 'other-project-example', title: originalLabel });
        const { extensionId, conversationId } = admitTaskDraft(server.db, lifecycle, { owner, name: `${owner === 'maya' ? 'Maya' : 'Leo'} completion follow-up` });
        let state = await lifecycle.compile(owner, { extensionId, hookId: TASK_HOOK, source: fixture.source, label: originalLabel, draftVersion: 0 }, () => {});
        state = await lifecycle.proposeScenarios(owner, { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.cases }, () => {});
        const input = { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion };
        state = await lifecycle.simulate(owner, input, () => {});
        expect(state.evidence.passed).toBe(true);
        state = lifecycle.approve(owner, { ...input, evidenceId: state.evidence.id }, () => {});
        initial[owner] = lifecycle.activate(owner, { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
        // Layout timing scripts public authoring receipts; saved task proof remains real.
        server.db.prepare('DELETE FROM extension_conversation_links WHERE conversation_id=?').run(conversationId);
        server.db.prepare('DELETE FROM authoring_conversations WHERE id=?').run(conversationId);
      }
      await use({ ...server, lifecycle, initial });
    }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
const ui = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const targets = new WeakMap();
const demos = new WeakMap();
async function api(page, path, body) {
  const response = await page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Session-Context': session.contextToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  }, { path, body });
  expect(response.status, JSON.stringify(response.value)).toBeLessThan(300);
  return response.value;
}
async function collection(page) { return api(page, 'extensions'); }
async function savedState(page) {
  const index = await collection(page), hashId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
  const known = targets.get(page);
  const id = hashId ?? (known?.owner === index.owner.id ? known.id : null) ?? index.selection.revision?.extensionId
    ?? (index.items.length === 1 ? index.items[0].extension.id : null);
  if (id) { targets.set(page, { owner: index.owner.id, id }); return api(page, 'extensions/' + encodeURIComponent(id)); }
  return { ...index, extension: null, draft: null, draftVersion: 0, evidence: null, approved: false, approvedEvidenceId: null, history: [], evidenceHistory: [] };
}
async function editSaved(page) { return page.locator('#edit-' + (await savedState(page)).extension.id); }
async function card(page) { return page.locator('.customization-card').filter({ has: await editSaved(page) }); }
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
  await ui(page).getByRole('button', { name: 'More', exact: true }).click();
  await openDeveloperTools(page);
}
async function openExampleDetails(results) {
  const summary = results.locator('.rs-example-details > summary');
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
}
async function enter(page, demo) {
  demos.set(page, demo);
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
  await expect(page.locator('.customization-card').first()).toBeVisible();
}
async function openStudio(page, inspect = true) {
  await overview(page); await (await editSaved(page)).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible();
  if (inspect && page.viewportSize().width > 1120 && page.viewportSize().height > 650) await openDetails(page);
}
async function picture(page, name) {
  mkdirSync(resolve('build/studio-extension-creation/layout-screens'), { recursive: true });
  await page.screenshot({ path: resolve('build/studio-extension-creation/layout-screens', `daymark-${name}.png`), fullPage: true });
}
async function refresh(page, close = true) {
  await openDetails(page);
  const reload = ui(page).getByRole('button', { name: 'Reload saved state', exact: true });
  await reload.click(); await expect(reload).toBeEnabled();
  if (close) await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
}
async function prepareChoice(page, label) {
  let state = await savedState(page);
  if (new URL(page.url()).hash === '#new=1') {
    const demo = demos.get(page);
    const { extensionId } = admitTaskDraft(demo.db, demo.lifecycle, { owner: state.owner.id, name: 'Layout fixture customization' });
    state = await api(page, 'extensions/' + extensionId);
    targets.set(page, { owner: state.owner.id, id: state.extension.id });
    await page.evaluate(id => { location.hash = new URLSearchParams({ customization: id }).toString(); }, state.extension.id);
    await expect(ui(page).getByRole('heading', { level: 2, name: state.extension.name, exact: true })).toBeVisible();
  }
  const projects = await api(page, 'projects');
  const project = projects[label === originalLabel ? 0 : Math.min(1, projects.length - 1)];
  const fixture = taskCustomizationFixture({ projectId: project.id, otherProjectId: 'other-project-example', title: label });
  const compiled = await api(page, `extensions/${state.extension.id}/compile`, { hookId: TASK_HOOK, source: fixture.source, label, draftVersion: state.draftVersion });
  const proposed = await api(page, `extensions/${state.extension.id}/scenarios`, { revisionId: compiled.draft.id, draftVersion: compiled.draftVersion, cases: fixture.cases });
  await refresh(page);
  await expect.poll(async () => (await savedState(page)).draft?.id).toBe(proposed.draft.id);
  expect((await savedState(page)).draft.label).toBe(label);
  expect(proposed.draft.pins.modelRef.format).toBe('keir-dcm/3');
  return proposed;
}
const choose = prepareChoice;
async function checkChoice(page) {
  const state = await savedState(page);
  const result = await api(page, `extensions/${state.extension.id}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
  await refresh(page);
  await expect(ui(page).getByRole('button', { name: 'See proposed change', exact: true }).first()).toBeEnabled();
  return result;
}
async function openRun(page, id) {
  await openDetails(page);
  const saved = await savedState(page), index = saved.evidenceHistory.findIndex(item => item.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  const history = ui(page).getByText('Saved sample runs', { exact: true });
  if (!await history.evaluate(node => node.parentElement.open)) await history.click();
  await ui(page).getByRole('button', { name: `Open saved sample run ${index + 1}`, exact: true }).click();
  const results = ui(page).getByRole('article', { name: 'Sample results', exact: true });
  await expect(results).toBeVisible();
  return results;
}
async function approve(page) {
  await openSavedChanges(page);
  await ui(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toBeFocused();
}
// Script only the public authoring receipts for layout timing. Simulation still uses the real scoped host service.
async function scriptLayoutAuthoring(page) {
  const calls = { turns: [], simulateNext: false };
  let current = null, creationOperationId = null;
  const availability = { available: true, code: null, provider: 'openai', model: 'synthetic-layout' };
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/authoring' && method === 'GET') return send({ availability, conversations: current ? [{ id: current.id, extensionId: current.extensionId,
      purpose: current.purpose, version: current.version, status: current.status, runId: current.runId, creationOperationId, operationId: current.operation.id }] : [],
      current: url.searchParams.get('extensionId') === current?.extensionId ? current : null });
    const match = url.pathname.match(/^\/api\/authoring\/conversations\/([^/]+)$/);
    if (match && method === 'GET') return current?.id === match[1] ? send(current) : send({ message: 'Unknown conversation' }, 404);
    if (url.pathname === '/api/authoring/turn' && method === 'POST') {
      const body = request.postDataJSON(); calls.turns.push(body);
      let state = await savedState(page);
      if (calls.simulateNext) {
        calls.simulateNext = false;
        state = await api(page, `extensions/${state.extension.id}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
      }
      const version = body.expectedVersion + 1, runId = `layout-run-${version}`;
      current = { id: body.conversationId ?? 'layout-conversation', extensionId: state.extension.id, purpose: 'REVISE', version, status: 'AWAITING_USER', runId,
        operation: { id: body.operationId, runId, version }, messages: [...(current?.messages ?? []),
          { id: `layout-user-${version}`, role: 'user', text: body.text, kind: 'text' },
          { id: `layout-assistant-${version}`, role: 'assistant', text: `Saved scripted response ${version}. What should I clarify?`, kind: 'clarification' }],
        code: null, review: null, draft: { revisionId: state.draft?.id ?? null, draftVersion: state.draftVersion, suiteDigest: state.draft?.suiteDigest ?? null },
        selection: { revisionId: state.selection.revision?.id ?? null, generation: state.selection.generation } };
      creationOperationId ??= body.operationId;
      return send({ operation: current.operation, conversation: current }, 202);
    }
    return send({ message: 'Unexpected scripted authoring request' }, 404);
  });
  return calls;
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


test('normal navigation preserves native forms and returns to the actual overview or detail invoker', async ({ page, demo }) => {
  await enter(page, demo);
  await expect(page).toHaveTitle('Daymark — tasks and customizations');
  await page.getByLabel('New task title').fill('Keep my quick-add');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill('Keep this project draft');
  await openStudio(page);
  await expect(page.locator('.project-link.selected')).toHaveCount(0);
  await appLockup(page);
  await expect(ui(page).getByRole('heading', { level: 2, name: (await savedState(page)).extension.name, exact: true })).toBeVisible();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(await editSaved(page)).toBeFocused();
  await destination(page, 'Tasks');
  await expect(page.locator('.project-link.selected')).toHaveCount(1);
  await expect(page.getByLabel('New task title')).toHaveValue('Keep my quick-add');
  await expect(page.getByLabel('New project name', { exact: true })).toHaveValue('Keep this project draft');
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Keep native detail title');
  await page.getByLabel('Notes (optional)').fill('Keep native detail notes');
  await page.locator('#open-customizations').click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(ui(page).getByRole('heading', { level: 1 })).toBeVisible();
  await ui(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.locator('#open-customizations')).toBeFocused();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep native detail title');
  await expect(page.getByLabel('Notes (optional)')).toHaveValue('Keep native detail notes');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Gather material references', exact: true })).toBeFocused();
});

test('overflowing native projects and tasks scroll independently with stable navigation and retained task position', async ({ page, demo }) => {
  const now = new Date().toISOString();
  for (let i = 0; i < 60; i++) demo.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(`overflow-project-${i}`, 'maya', `Overflow project ${i}`, now, now);
  const project = demo.db.prepare("SELECT id FROM projects WHERE owner_id='maya' ORDER BY created_at LIMIT 1").get().id;
  for (let i = 0; i < 80; i++) demo.db.prepare('INSERT INTO tasks (id, owner_id, project_id, title, notes, status, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`overflow-task-${i}`, 'maya', project, `Overflow task ${i}`, '', 'open', now, now, null);
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


test('general start offers editable requests and distinguishes untouched from off setups with history', async ({ page, demo }) => {
  await page.goto(demo.origin); await page.getByRole('button', { name: 'Continue as Sam' }).click();
  await destination(page, 'Customizations');
  await expect(page.getByText('Your customizations will appear here.', { exact: true })).toBeVisible();
  await expect(page.locator('.customization-card')).toHaveCount(0);
  const before = await collection(page); let mutations = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(extensions|authoring)/.test(request.url())) mutations++; });
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByRole('heading', { name: 'What would you like Daymark to do for you?' })).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'Prioritize new requests', exact: true })).toBeVisible();
  await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible();
  await expect(ui(page).getByRole('button', { name: /See available starting points|Pending for open tasks|Needs attention for open tasks|Change choice/ })).toHaveCount(0);
  await expect(ui(page).getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
  await expect(ui(page).getByText('Set up the assistant to create or change a customization.', { exact: true })).toBeVisible();
  await expect(ui(page).getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
  await picture(page, 'general-start'); expect(await collection(page)).toEqual(before); expect(mutations).toBe(0);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeFocused();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('maya');
  await openStudio(page);
  const beforeOff = await savedState(page);
  const status = ui(page).getByLabel('Customization status');
  const disable = status.getByRole('button', { name: 'Turn off this customization', exact: true });
  const request = page.waitForRequest(item => item.method() === 'POST' && new URL(item.url()).pathname.endsWith('/disable'));
  await disable.press('Enter');
  expect((await request).postDataJSON()).toEqual({ generation: beforeOff.selection.generation });
  await expect(disable).toHaveCount(0);
  await expect(status.locator('strong')).toBeFocused();
  const off = await savedState(page);
  expect(off.selection.revision).toBeNull(); expect(off.draft.id).toBe(beforeOff.draft.id);
  expect(off.approvedEvidenceId).toBe(beforeOff.approvedEvidenceId); expect(off.history.length).toBeGreaterThan(0);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(await card(page)).toContainText('Approved · Not on yet'); await picture(page, 'general-off');
  const beforeNew = await collection(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible(); expect(await collection(page)).toEqual(beforeNew);
});

test('saved draft resumes in chat and failed saved-state reads offer Retry', async ({ page, demo }) => {
  await enter(page, demo); await overview(page); const initial = await collection(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible(); expect(await collection(page)).toEqual(initial);
  await prepareChoice(page, proposedLabel); const draft = await savedState(page);
  await ui(page).getByRole('button', { name: 'Back to Customizations' }).click();
  await expect(await editSaved(page)).toContainText('Continue changes'); await destination(page, 'Tasks');
  await page.route('**/api/extensions', route => route.abort('failed'));
  await destination(page, 'Customizations'); await expect(page.getByRole('alert')).toContainText('Customizations could not be checked');
  await expect(page.getByText('Your customizations will appear here.', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/extensions'); await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(await editSaved(page)).toBeEnabled(); await picture(page, 'discovery-continue');
  await (await editSaved(page)).click(); await openDetails(page);
  await expect(ui(page).getByRole('button', { name: 'Reload saved state', exact: true })).toBeEnabled(); expect(await savedState(page)).toEqual(draft);
});

test('approved run stays exact after a newer run and remount until explicit reapproval', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page, false); const proposed = await choose(page, proposedLabel);
  await checkChoice(page); await picture(page, 'conversation-default'); await approve(page);
  const approved = await savedState(page), a = approved.approvedEvidenceId; expect(a).toBe(approved.evidence.id);
  await ui(page).getByRole('button', { name: 'Hide simulation', exact: true }).click();
  await expect(ui(page).locator('.rs-preview')).toBeHidden(); await checkChoice(page);
  const b = (await savedState(page)).evidence.id; expect(b).not.toBe(a); expect((await savedState(page)).approvedEvidenceId).toBe(a);
  await page.reload(); await expect(ui(page).locator('.rs-preview')).toBeHidden();
  await openSavedChanges(page); await expect(ui(page).getByRole('button', { name: 'Turn on for tasks completed' })).toBeEnabled();
  await ui(page).getByRole('button', { name: 'Hide simulation', exact: true }).click();
  let results = await openRun(page, a); await results.locator('.rs-example-details > summary').click();
  await expect(results).toContainText(`Evidence: ${a}`); await openExampleDetails(results);
  await expect(results.getByText('Approved run', { exact: true })).toBeVisible();
  results = await openRun(page, b); await expect(results).toContainText(`Evidence: ${b}`); await openExampleDetails(results);
  await expect(results.getByText('Latest run', { exact: true })).toBeVisible();
  await expect(results.getByText('Approved run', { exact: true })).toHaveCount(0); await picture(page, 'approved-latest');
  await ui(page).getByRole('button', { name: 'Back to conversation' }).click();
  await openSavedChanges(page);
  await ui(page).getByRole('button', { name: 'Review the newer checked examples', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
  expect((await savedState(page)).approvedEvidenceId).toBe(a); await approve(page);
  await expect.poll(async () => (await savedState(page)).approvedEvidenceId).toBe(b);
  expect((await savedState(page)).draft.id).toBe(proposed.draft.id);
  expect((await savedState(page)).selection.revision.id).toBe(demo.initial.maya.selection.revision.id);
  expect((await savedState(page)).selection.approvedEvidenceId).toBe(demo.initial.maya.approvedEvidenceId);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`approved reentry ${viewport.width}x${viewport.height} keeps chat open until the saved use decision is requested`, async ({ page, demo }) => {
    await page.setViewportSize(viewport); await enter(page, demo); await openStudio(page, false);
    const proposed = await choose(page, proposedLabel); await checkChoice(page); await approve(page);
    const checked = await savedState(page);
    await ui(page).getByRole('button', { name: 'Back to Customizations' }).click(); await (await editSaved(page)).click();
    await expect(ui(page).locator('.rs-preview')).toBeHidden();
    await openSavedChanges(page);
    const use = ui(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true });
    await expect(use).toBeEnabled(); await use.scrollIntoViewIfNeeded(); await expect(use).toBeInViewport();
    await expect(ui(page).getByLabel('Customization status')).toContainText('Approved');
    await expect(ui(page).getByRole('button', { name: /Pending for open tasks|Needs attention for open tasks/ })).toHaveCount(0);
    expect((await savedState(page)).selection.revision.id).toBe(demo.initial.maya.selection.revision.id); await picture(page, `approved-resume-${viewport.width}x${viewport.height}`);
    await use.click();
    await expect(ui(page).getByLabel('Customization status')).toContainText('On for my tasks');
    await expect(ui(page).getByRole('article', { name: 'Advice is on' })).toHaveCount(0);
    await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible();
    await expect.poll(async () => (await savedState(page)).selection.revision.id).toBe(proposed.draft.id);
    expect((await savedState(page)).selection.revision.label).toBe(proposedLabel);
    expect((await savedState(page)).selection.approvedEvidenceId).toBe(checked.evidence.id);
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 683, height: 384 }]) {
  test(`inline review ${viewport.width}x${viewport.height} keeps saved checks and composer in the conversation`, async ({ page, demo }) => {
    await page.setViewportSize(viewport); await enter(page, demo); await openStudio(page, false);
    const studio = ui(page), composer = studio.getByLabel('Message to Daymark assistant');
    await expect(studio.locator('.rs-preview')).toBeHidden(); await expect(studio.getByRole('separator')).toHaveCount(0);
    await prepareChoice(page, proposedLabel); await composer.fill('Keep this unsent thought');
    const log = studio.getByRole('log');
    const flowing = viewport.width <= 600 || viewport.height <= 500;
    const scroller = flowing ? studio : log;
    await expect(scroller).toHaveCSS('overflow-y', 'auto');
    if (flowing) await expect(log).toHaveCSS('overflow-y', 'visible');
    if (viewport.height === 384) {
      const fetched = Promise.withResolvers(), release = Promise.withResolvers();
      const path = `**/api/extensions/${(await savedState(page)).extension.id}/simulate`;
      await page.route(path, async route => {
        const response = await route.fetch();
        fetched.resolve();
        await release.promise;
        await route.fulfill({ response });
      });
      try {
        await studio.getByRole('button', { name: 'Check this revised change', exact: true }).click();
        await fetched.promise;
        await wheel(page, scroller, -100_000);
      } finally { release.resolve(); }
      await expect(studio.getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
      await page.unroute(path);
    } else await checkChoice(page);
    const named = studio.getByRole('button', { name: 'See proposed change', exact: true }).first();
    await named.click(); const heading = studio.getByRole('heading', { name: 'Summary', exact: true });
    await expect(heading).toBeFocused();
    const results = studio.getByRole('article', { name: 'Current decision' });
    const action = results.getByRole('button', { name: 'Approve this change', exact: true });
    await expect(action).toBeEnabled();
    await expect(log.getByRole('article', { name: 'About this rule', exact: true }).getByRole('heading')).toHaveText('Summary');
    await expect(studio.getByRole('heading', { level: 1 })).toHaveText(`Create “${proposedLabel}” tasks`);
    await expect(log.getByRole('article', { name: 'Current decision' })).toHaveCount(1);
    if (!flowing) await expect(composer).toBeInViewport();
    const rows = results.getByRole('article', { name: /^Example:/ });
    await expect(rows).toHaveCount(6);
    await expect(results.locator('.rs-coverage')).toContainText('Not covered by this simulation');
    await expect(results.locator('.rs-coverage')).toContainText(/These examples do not cover|Only the situations listed here were simulated/);
    await expect(results.locator('.rs-coverage')).not.toContainText('An unconfirmed change may have happened');
    await expect(rows.nth(1)).toBeVisible();
    if (viewport.width === 1440 || viewport.width === 390) {
      const summary = log.getByRole('article', { name: 'About this rule', exact: true });
      await expect(summary.locator('.rs-rule-summary')).toContainText(`create a new task titled “${proposedLabel}”`);
      await summary.evaluate(node => node.scrollIntoView({ block: 'start' }));
      await picture(page, `studio-saved-rule-${viewport.width}x${viewport.height}`);
      const simulation = results.getByRole('heading', { name: 'Simulation', exact: true });
      await simulation.evaluate(node => node.scrollIntoView({ block: 'start' }));
      await picture(page, `studio-simulation-rows-${viewport.width}x${viewport.height}`);
    }
    await expect(log.getByRole('article', { name: 'About this rule', exact: true }).locator('.rs-rule-summary')).toContainText(`create a new task titled “${proposedLabel}”`);
    if (viewport.height === 384) {
      await expect(studio.getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
      await expect(studio.locator('.rs-setup-notice')).toContainText('Set up the assistant');
      await expect.poll(async () => {
        const available = await scroller.boundingBox(), button = await action.boundingBox();
        return available.height - button.height;
      }).toBeGreaterThanOrEqual(0);
    }
    await action.evaluate((button, flowing) => {
      const scroller = button.closest(flowing ? '.read-studio' : '[role="log"]');
      const target = button.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      scroller.scrollTop += (target.top + target.bottom - bounds.top - bounds.bottom) / 2;
    }, flowing);
    await expect(action).toBeInViewport({ ratio: 0.99 });
    if (flowing) await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeInViewport({ ratio: 0.99 });
    if (viewport.height === 384) await picture(page, 'short-inline-unread-action-visible');
    const id = (await savedState(page)).evidence.id;
    await results.getByRole('button', { name: 'Hide simulation', exact: true }).click(); await expect(named).toBeFocused();
    await expect(studio.locator('.rs-preview')).toBeHidden(); await expect(studio.getByRole('separator')).toHaveCount(0);
    await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('.rs-preview'))).toBe(false);
    await named.click(); await expect(heading).toBeFocused();
    await expect(action).toBeEnabled();
    await expect(rows.nth(1)).toBeVisible();
    await expect(composer).toHaveValue('Keep this unsent thought');
    await results.getByText('Technical details for this version', { exact: true }).click();
    await expect(results).toContainText(`Evidence: ${id}`);
    await expect(results.getByLabel('Exact checked examples', { exact: true })).toContainText(id);
    await expect(results).toContainText('Example tasks; your tasks are unchanged.');
    await bounded(page); await picture(page, `on-demand-results-${viewport.width}x${viewport.height}`);
    if (viewport.width === 1440 || viewport.width === 390) {
      const inspect = results.getByRole('button', { name: 'Inspect examples and what’s in use', exact: true });
      await inspect.click();
      const comparison = studio.getByRole('article', { name: 'Sample results', exact: true });
      const singleColumn = /^\d+(?:\.\d+)?px$/;
      await expect(comparison.locator('.rs-proof-comparison').first()).toHaveCSS('grid-template-columns', singleColumn);
      await expect(comparison.locator('.rs-example dl').first()).toHaveCSS('grid-template-columns', singleColumn);
      await picture(page, `studio-comparison-${viewport.width}x${viewport.height}`);
      await studio.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(inspect).toBeFocused();
      await expect(composer).toHaveValue('Keep this unsent thought');
    }
  });
}

test('overview reflects real draft, approved, selected, off and unavailable states without a task-specific entry', async ({ page, demo }) => {
  await page.goto(demo.origin); await appLockup(page); await picture(page, 'welcome');
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible(); await appLockup(page); await picture(page, 'tasks');
  await openStudio(page); await picture(page, 'studio-current'); const proposal = await choose(page, proposedLabel); await picture(page, 'studio-draft');
  const checked = await checkChoice(page); await openRun(page, checked.evidence.id);
  await expect(ui(page).getByRole('region', { name: 'Saved proposed example', exact: true }).locator('.rs-example')).toHaveCount(1); await ui(page).getByText('Other checked examples', { exact: true }).click();
  await expect(ui(page).getByText('Other checked examples', { exact: true }).locator('..').getByRole('button')).toHaveCount(5);
  await picture(page, 'studio-results'); await ui(page).getByRole('button', { name: 'Back to conversation' }).click();
  await picture(page, 'studio-review'); await approve(page);
  await expect(ui(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toBeInViewport();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  let item = await card(page); await expect(item).toContainText('In use · Approved changes ready to turn on');
  const draftState = await savedState(page); expect(draftState.draft.label).toBe(proposedLabel); expect(draftState.selection.revision.label).toBe(originalLabel);
  expect(draftState.draft.id).toBe(proposal.draft.id); expect(draftState.approvedEvidenceId).toBe(checked.evidence.id);
  expect(draftState.selection.revision.id).toBe(demo.initial.maya.selection.revision.id);
  expect((await savedState(page)).approved).toBe(true); await (await editSaved(page)).click();
  await openSavedChanges(page);
  await ui(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true }).click();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  item = await card(page); await expect(item.locator('.state-badge')).toHaveText('In use'); await expect(item).not.toContainText('Changes in progress');
  expect((await savedState(page)).selection.revision.label).toBe(proposedLabel);
  expect((await savedState(page)).selection.revision.id).toBe(proposal.draft.id);
  expect((await savedState(page)).selection.approvedEvidenceId).toBe(checked.evidence.id);
  await picture(page, 'overview-in-use');
  demo.db.prepare("UPDATE extension_authored SET artifact=x'00' WHERE revision_id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted')").run();
  await destination(page, 'Tasks'); await overview(page); await expect(await card(page)).toContainText('Couldn’t check what’s in use');
  await expect(await card(page)).not.toContainText('completed tasks: Done'); await picture(page, 'overview-unavailable');
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam'); await destination(page, 'Customizations');
  await expect(page.locator('.customization-card')).toHaveCount(0); await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(ui(page).getByLabel('Message to Daymark assistant')).toBeVisible(); expect((await savedState(page)).selection.revision).toBeNull(); expect((await savedState(page)).draft).toBeNull();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click(); await expect(page.locator('.customization-card')).toHaveCount(0); await picture(page, 'overview-off');
});
test('transcript and canvas own wheel and PageDown; arrivals preserve earlier reading and splitter keeps usable widths', async ({ page, demo }) => {
  await enter(page, demo); const fixture = await scriptLayoutAuthoring(page); await openStudio(page);
  const log = ui(page).getByRole('log'), canvas = ui(page).locator('.rs-canvas'), composer = ui(page).locator('.rs-composer');
  const header = page.locator('.workspace-top'), rail = page.locator('.rail');
  for (let i = 0; i < 13; i++) { await ui(page).getByLabel('Message to Daymark assistant').fill(`Message ${i}: ${'Please explain this example. '.repeat(10)}`); await ui(page).getByRole('button', { name: 'Send', exact: true }).click(); }
  await expect.poll(() => fixture.turns.length).toBe(13); await expect(log.locator('.rs-yours')).toHaveCount(13);
  await expect(log.getByText(/Saved scripted response \d+\. What should I clarify\?/)).toHaveCount(13);
  await log.evaluate(node => node.scrollTop = 0); const geometry = { composer: await composer.boundingBox(), header: await header.boundingBox(), rail: await rail.boundingBox() };
  await wheel(page, log, 400); await expect.poll(() => scrollTop(log)).toBeGreaterThan(100); expect(await scrollTop(canvas)).toBe(0); await pageDown(page, log);
  await log.evaluate(node => node.scrollTop = 0); await ui(page).getByLabel('Message to Daymark assistant').fill('A new message while reading earlier replies'); await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible(); await expect.poll(() => fixture.turns.length).toBe(14); expect(await scrollTop(log)).toBe(0);
  await openDetails(page); await ui(page).getByText('Restore an earlier version', { exact: true }).click(); await ui(page).getByText('Selection history and exact identities', { exact: true }).click();
  await wheel(page, canvas, 120); await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(50); expect(await scrollTop(log)).toBe(0); await pageDown(page, canvas);
  await canvas.evaluate(node => node.scrollTop = node.scrollHeight); await wheel(page, canvas, 600); expect(await scrollTop(log)).toBe(0);
  expect(await composer.boundingBox()).toEqual(geometry.composer); expect(await header.boundingBox()).toEqual(geometry.header); expect(await rail.boundingBox()).toEqual(geometry.rail);
  const divider = ui(page).getByRole('separator'); for (const key of ['Home', 'ArrowRight', 'End', 'ArrowLeft']) { await divider.focus(); await divider.press(key); }
  expect((await ui(page).locator('.rs-chat').boundingBox()).width).toBeGreaterThanOrEqual(300); expect((await ui(page).locator('.rs-preview').boundingBox()).width).toBeGreaterThanOrEqual(340);
  await divider.press('Home'); await expect(divider).toHaveAttribute('aria-valuenow', await divider.getAttribute('aria-valuemin'));
  await divider.press('End'); const max = await divider.getAttribute('aria-valuemax');
  await expect(divider).toHaveAttribute('aria-valuenow', max);
  const handle = await divider.boundingBox(), y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y); await page.mouse.down();
  await page.mouse.move(handle.x - 70, y); await page.mouse.up();
  await expect(divider).not.toHaveAttribute('aria-valuenow', max);
  await bounded(page); await picture(page, 'studio-history-overflow');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 900, height: 500 }, { width: 360, height: 540 }, { width: 683, height: 384 }]) {
  test(`narrow/short ${viewport.width}x${viewport.height} has direct entry, retained panes/composer and keyboard-reachable actions`, async ({ page, demo }) => {
    await page.setViewportSize(viewport); await enter(page, demo); const fixture = await scriptLayoutAuthoring(page); await openStudio(page); await appLockup(page);
    const studio = ui(page), log = studio.getByRole('log'), composer = studio.getByLabel('Message to Daymark assistant'); await composer.fill('Keep this unsent message');
    await expect(studio).toHaveCSS('overflow-y', 'auto');
    await expect(log).toHaveCSS('overflow-y', 'visible');
    const disable = studio.getByLabel('Customization status').getByRole('button', { name: 'Turn off this customization', exact: true });
    await expect(disable).toBeEnabled();
    await expect(disable).toBeInViewport({ ratio: 1 });
    await studio.locator('.rs-composer').scrollIntoViewIfNeeded();
    const box = await studio.locator('.rs-composer').boundingBox();
    // Scroll offsets round to whole pixels while form bounds can remain fractional.
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    for (let i = 0; i < 5; i++) { await composer.fill(`Long example ${i} ${'explain this task '.repeat(14)}`); await studio.getByRole('button', { name: 'Send', exact: true }).click(); }
    await expect.poll(() => fixture.turns.length).toBe(5); await expect(studio.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await composer.fill('Keep this unsent message'); await studio.evaluate(node => node.scrollTop = 0); await wheel(page, studio, 300);
    await expect.poll(() => scrollTop(studio)).toBeGreaterThan(0); const logPosition = await scrollTop(studio);
    expect(await scrollTop(log)).toBe(0); await picture(page, `studio-conversation-${viewport.width}x${viewport.height}`);
    await openDetails(page); await expect(studio.locator('.rs-chat')).toBeHidden(); await expect(disable).toBeInViewport({ ratio: 1 });
    await studio.getByText('Restore an earlier version', { exact: true }).click(); await studio.getByText('Selection history and exact identities', { exact: true }).click();
    const canvas = studio.locator('.rs-canvas'); await expect(canvas).toHaveCSS('overflow-y', 'auto');
    await wheel(page, canvas, 300); await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(0);
    await studio.getByRole('button', { name: 'Back to conversation', exact: true }).click(); await expect(composer).toHaveValue('Keep this unsent message');
    await expect(studio).toHaveCSS('overflow-y', 'auto'); expect(await scrollTop(studio)).toBe(logPosition); expect(await scrollTop(log)).toBe(0);
    await studio.getByRole('button', { name: 'More', exact: true }).click();
    await expect(studio.getByRole('heading', { name: 'Versions and settings', exact: true })).toBeFocused();
    await expect(studio.getByRole('heading', { name: 'Versions and settings', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(studio.locator('.rs-developer-tools')).toHaveJSProperty('open', false);
    await openDeveloperTools(page); await canvas.focus(); await page.keyboard.press('PageDown');
    await studio.getByRole('button', { name: 'Reload saved state', exact: true }).focus(); await page.keyboard.press('Tab'); await bounded(page); await picture(page, `studio-${viewport.width}x${viewport.height}`);
    await studio.getByRole('button', { name: 'Back to Customizations', exact: true }).click(); await expect(await editSaved(page)).toBeFocused();
  });
}

test('late overview and Studio reads cannot repopulate an abandoned destination or an away-and-back owner', async ({ page, demo }) => {
  await enter(page, demo); let release, arrived, delivered;
  const started = new Promise(done => { arrived = done; }), finished = new Promise(done => { delivered = done; });
  await page.route('**/api/extensions', async route => { const response = await route.fetch(); arrived(); await new Promise(done => { release = done; }); try { await route.fulfill({ response }); } catch {} delivered(); });
  try {
    await destination(page, 'Customizations'); await started; await destination(page, 'Tasks'); await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('heading', { name: 'Neighbourhood workshop', exact: true })).toBeVisible(); await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('maya');
    release(); await finished; await page.unroute('**/api/extensions'); await expect(page.locator('.customization-card')).toHaveCount(0);
    await overview(page); const maya = await savedState(page); await expect(await card(page)).toContainText(maya.extension.name); await (await editSaved(page)).click();
    await expect(ui(page).getByRole('heading', { level: 2, name: maya.extension.name, exact: true })).toBeVisible(); expect((await savedState(page)).owner.id).toBe('maya');
    let releaseStudio, arrivedStudio; const studioStarted = new Promise(done => { arrivedStudio = done; }); const exact = `**/api/extensions/${maya.extension.id}`;
    await page.route(exact, async route => { const response = await route.fetch(); arrivedStudio(); await new Promise(done => { releaseStudio = done; }); try { await route.fulfill({ response }); } catch {} });
    await openDetails(page); await ui(page).getByRole('button', { name: 'Reload saved state', exact: true }).click(); await studioStarted;
    await destination(page, 'Tasks'); await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo'); releaseStudio(); await page.unroute(exact);
    await openStudio(page); const leo = await savedState(page); expect(leo.owner.id).toBe('leo'); expect(leo.extension.id).not.toBe(maya.extension.id);
    await expect(ui(page).getByRole('heading', { level: 2, name: leo.extension.name, exact: true })).toBeVisible(); await expect(ui(page).getByLabel('Customization status')).not.toContainText('Maya');
  } finally { release?.(); }
});

async function preparePendingRun(page) {
  await choose(page, proposedLabel); await checkChoice(page); const original = await savedState(page);
  const fixture = await scriptLayoutAuthoring(page); await refresh(page); await openDetails(page);
  const status = ui(page).getByRole('button', { name: 'Check authoring status', exact: true });
  await status.click(); await expect(status).toBeEnabled();
  await ui(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await openRun(page, original.evidence.id);
  return { original, fixture };
}
async function selectOtherExample(page) {
  const results = ui(page).getByRole('article', { name: 'Sample results', exact: true });
  const other = results.getByText('Other checked examples', { exact: true });
  if (!await other.evaluate(node => node.parentElement.open)) await other.click();
  await other.locator('..').getByRole('button', { name: /^Saved example:/ }).first().click();
  await expect(results.getByRole('region', { name: 'Saved proposed example', exact: true })).toContainText('No change.');
  return results;
}

test('a newly produced real sample run does not replace historical evidence being read', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page, false); const { original, fixture } = await preparePendingRun(page); await choose(page, originalLabel);
  const oldResults = await openRun(page, original.evidence.id), originalUnfinished = await oldResults.locator('[aria-label="Expected and actual sample results"]').textContent();
  const studio = ui(page); let requests = 0, release, arrived, delivered;
  const started = new Promise(done => { arrived = done; }), finished = new Promise(done => { delivered = done; });
  await page.route(`**/api/extensions/${original.extension.id}/simulate`, async route => {
    requests++; const response = await route.fetch(); expect((await response.json()).evidence.id).not.toBe(original.evidence.id); arrived(); await new Promise(done => { release = done; }); await route.fulfill({ response }); delivered();
  });
  try {
    fixture.simulateNext = true; await studio.getByLabel('Message to Daymark assistant').fill('Try these examples again.'); await studio.getByRole('button', { name: 'Send', exact: true }).click(); await started;
    const results = await selectOtherExample(page); const content = await results.locator('[aria-label="Expected and actual sample results"]').textContent();
    await results.locator('.rs-example-details > summary').click(); await expect(results).toContainText(`Evidence: ${original.evidence.id}`);
    const canvas = studio.locator('.rs-canvas'); await wheel(page, canvas, 180); const position = await scrollTop(canvas);
    await expect(studio.getByRole('button', { name: 'Send', exact: true })).toBeDisabled(); await studio.getByRole('button', { name: 'Send', exact: true }).click({ force: true }); expect(requests).toBe(1);
    release(); await finished; await expect.poll(() => fixture.turns.length).toBe(1); await expect(studio.getByRole('button', { name: 'See proposed change', exact: true }).first()).toBeEnabled();
    await expect(studio.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    expect(await results.locator('[aria-label="Expected and actual sample results"]').textContent()).toBe(content); await expect(results).toContainText(`Evidence: ${original.evidence.id}`); expect(await scrollTop(canvas)).toBe(position);
    const latest = await savedState(page); await openRun(page, latest.evidence.id); await expect(results).toContainText('Saved sample run · Current proposal');
    expect(await results.locator('[aria-label="Expected and actual sample results"]').textContent()).not.toBe(originalUnfinished);
    await expect(results.locator('[aria-label="Expected and actual sample results"]')).toContainText(originalLabel);
  } finally { release?.(); }
});

for (const operation of ['simulate', 'approve', 'activate']) {
  test(`an already-produced ${operation} response preserves explicitly selected sample reading`, async ({ page, demo }) => {
    await enter(page, demo); await openStudio(page, false); const { original, fixture } = await preparePendingRun(page); const studio = ui(page);
    const checked = await api(page, `extensions/${original.extension.id}/evidence/${original.evidence.id}`);
    const nonmatching = checked.reports.find(item => item.id === 'other-project').report;
    expect(nonmatching.observed).toEqual({ effect: 'NONE', createdTasks: [], updatedTasks: [] });
    const nonmatch = nonmatching.scenario.task;
    const nonmatchLabel = `Example: Task completed in ${nonmatch.projectName}`;
    if (operation === 'activate') { await approve(page); await openRun(page, original.evidence.id); }
    let release, arrived, delivered; const started = new Promise(done => { arrived = done; }), finished = new Promise(done => { delivered = done; });
    await page.route(`**/api/extensions/${original.extension.id}/${operation}`, async route => {
      const response = await route.fetch(), saved = await response.json(); expect(saved.draft.id).toBe(original.draft.id); expect(saved.draftVersion).toBe(original.draftVersion);
      if (operation === 'simulate') { expect(saved.selection.generation).toBe(original.selection.generation); expect(saved.evidence.id).not.toBe(original.evidence.id); }
      else { expect(saved.evidence.id).toBe(original.evidence.id); expect(saved.approved).toBe(true); expect(saved.selection.generation).toBe(original.selection.generation + (operation === 'activate' ? 1 : 0)); if (operation === 'activate') expect(saved.selection.revision.id).toBe(original.draft.id); }
      arrived(); await new Promise(done => { release = done; }); await route.fulfill({ response }); delivered();
    });
    try {
      if (operation === 'simulate') { fixture.simulateNext = true; await studio.getByLabel('Message to Daymark assistant').fill('Try the saved examples again.'); await studio.getByRole('button', { name: 'Send', exact: true }).click(); }
      else {
        await openSavedChanges(page);
        await studio.getByRole('button', { name: operation === 'approve' ? 'Approve this change' : 'Turn on for tasks completed', exact: true }).click();
      }
      await started;
      let results, proof;
      if (operation === 'simulate') {
        results = await selectOtherExample(page);
        await results.locator('.rs-example-details > summary').click();
      } else {
        results = studio.getByRole('article', { name: 'Current decision', exact: true });
        await expect(results.getByRole('article', { name: /^Example:/ }).first()).toBeVisible();
        await results.getByText('Technical details for this version', { exact: true }).click();
        proof = await results.getByLabel('Exact checked examples', { exact: true }).textContent();
      }
      const anchor = operation === 'simulate'
        ? results.getByRole('region', { name: 'Saved proposed example', exact: true }).getByRole('article', { name: nonmatchLabel, exact: true })
        : results.getByRole('article', { name: /^Example:/ }).filter({ has: page.locator('dd').filter({ hasText: `“${nonmatch.projectName}”` }) });
      if (operation !== 'simulate' && !await anchor.locator('.rs-case-disclosure').evaluate(element => element.open))
        await anchor.locator('.rs-case-disclosure > summary').click();
      await expect(anchor.locator('dd').nth(2)).toBeVisible();
      const content = await anchor.locator('dd').allTextContents();
      const scroller = operation === 'simulate' ? studio.locator('.rs-canvas') : studio.getByRole('log');
      await scroller.focus(); await anchor.evaluate(node => node.scrollIntoView({ block: 'start' }));
      await expect(anchor).toBeInViewport();
      expect(await scrollTop(scroller)).toBeGreaterThan(0);
      const position = (await anchor.boundingBox()).y;
      release(); await finished; await expect(results).toBeVisible(); await expect(results).toContainText(`Evidence: ${original.evidence.id}`);
      expect(await anchor.locator('dd').allTextContents()).toEqual(content); await expect(scroller).toBeFocused(); expect(await scrollTop(scroller)).toBeGreaterThan(0);
      expect(Math.abs((await anchor.boundingBox()).y - position)).toBeLessThanOrEqual(1);
      if (operation !== 'simulate') {
        await openRun(page, original.evidence.id);
        results = await selectOtherExample(page);
        // Inline review adds the draft’s condition; saved inspection keeps the recorded no-change observation.
        await expect(results.getByRole('region', { name: 'Saved proposed example', exact: true }).getByRole('article', { name: nonmatchLabel, exact: true }).locator('dd').nth(2)).toHaveText('No change.');
      }
      await openExampleDetails(results);
      if (proof) expect(await results.getByLabel('Saved synthetic simulation report', { exact: true }).textContent()).toBe(proof);
      await expect(results).toContainText(operation === 'simulate' ? 'Earlier run for current proposal' : 'Current proposal');
      await expect(results.getByRole('button', { name: /Review this|Approve|Turn on/ })).toHaveCount(0);
      if (operation === 'activate') expect((await savedState(page)).selection.revision.id).toBe(original.draft.id);
      else expect((await savedState(page)).selection.revision.id).toBe(original.selection.revision.id);
    } finally { release?.(); }
  });
}
