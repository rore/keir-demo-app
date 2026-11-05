import { test as base, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';
import { createApp } from '../../src/app.mjs';
import { openData, taskService } from '../../src/data.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { taskCustomizationFixture, compileTaskCustomization } from '../fixtures/task-customization.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { spawn } from 'node:child_process';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-lifecycle-browser-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let server;
    try {
      server = await start({ directory, port });
      const lifecycle = createLifecycle(server.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
      const project = taskService(server.db).listProjects('maya')[0];
      const fixture = taskCustomizationFixture({ projectId: project.id, otherProjectId: 'other-project-example', title: 'Original follow-up' });
      const { extensionId, conversationId } = admitTaskDraft(server.db, lifecycle, { name: 'Completion follow-up' });
      let state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, source: fixture.source, label: 'Original follow-up', draftVersion: 0 }, () => {});
      state = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.cases }, () => {});
      const input = { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion };
      state = await lifecycle.simulate('maya', input, () => {});
      expect(state.evidence.passed).toBe(true);
      state = lifecycle.approve('maya', { ...input, evidenceId: state.evidence.id }, () => {});
      lifecycle.activate('maya', { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
      // This suite reviews host-saved work; provider conversations have their own journey tests.
      server.db.prepare('DELETE FROM extension_conversation_links WHERE conversation_id=?').run(conversationId);
      server.db.prepare('DELETE FROM authoring_conversations WHERE id=?').run(conversationId);
      await use({ origin: server.origin, restart: async () => { await server.close(); server = await start({ directory, port }); },
        invalidateSelected: () => server.db.prepare("UPDATE extension_authored SET artifact=x'00' WHERE revision_id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted')").run() });
    } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
async function openDetails(page) {
  await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
}
async function tasks(page) {
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const destination = page.getByLabel('Destination', { exact: true });
  if (await destination.isVisible()) await destination.selectOption('tasks');
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await tasks(page);
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
}
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function open(page) {
  await page.locator('#open-customizations').click();
  await expect(studio(page).getByRole('button', { name: 'History and details', exact: true })).toBeEnabled();
  expect(await studio(page).locator('.rs-composer').evaluate(form => form.getBoundingClientRect().height)).toBeLessThan(180);
  expect(await studio(page).locator('.rs-header').evaluate(header => header.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
}
const decision = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
const approval = page => decision(page).getByRole('button', { name: 'Approve this change', exact: true });
async function closeDetails(page) {
  const close = studio(page).getByRole('button', { name: 'Back to conversation', exact: true });
  if (await close.isVisible()) await close.click();
}
async function latestExamples(page, historical = false) {
  await openDetails(page);
  const summary = studio(page).getByText('Saved sample runs', { exact: true });
  if (!await summary.locator('..').evaluate(node => node.open)) await summary.click();
  await studio(page).getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
  const project = (await nativeRequest(page, 'projects'))[0];
  await expect(studio(page).getByRole('heading', { name: historical ? 'Earlier examples' : `Saved example: Completed task in “${project.name}”`, exact: true })).toBeVisible();
}
async function checkSaved(page) {
  const saved = await savedLifecycle(page, page.url());
  const checked = await lifecyclePost(page, 'simulate', { revisionId: saved.revisionId, draftVersion: saved.draftVersion });
  await reloadStudio(page);
  if (checked.evidence.passed || checked.approved) await openSavedChanges(page);
  return checked;
}
async function prepare(page, label = 'Customer follow-up') {
  const saved = await savedLifecycle(page, page.url());
  const fixture = await authoredFixture(page, label);
  const compiled = await lifecyclePost(page, 'compile', { hookId: TASK_HOOK, source: fixture.source, label, draftVersion: saved.draftVersion });
  await lifecyclePost(page, 'scenarios', { revisionId: compiled.draft.id, draftVersion: compiled.draftVersion, cases: fixture.cases });
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  await expect(approval(page)).toBeEnabled();
  await expect(decision(page).getByRole('region', { name: 'Checked proposed behavior', exact: true }).locator('.rs-compact-case:visible')).toHaveCount(fixture.cases.length);
  await latestExamples(page);
  const proposed = studio(page).getByRole('region', { name: 'Saved proposed example', exact: true });
  await expect(proposed.locator('.rs-example:visible')).toHaveCount(1);
  await expect(proposed.getByText('Matches what you wanted', { exact: true })).toHaveCount(1);
  const otherExamples = studio(page).getByText('Other checked examples', { exact: true });
  if (!await otherExamples.locator('..').evaluate(node => node.open)) await otherExamples.click();
  const alternatives = otherExamples.locator('..').getByRole('button', { name: /^Saved example:/ });
  await expect(alternatives).toHaveCount(fixture.cases.length - 1);
  for (let index = 0; index < fixture.cases.length - 1; index++) {
    await alternatives.nth(index).click();
    await expect(proposed.getByText('Matches what you wanted', { exact: true })).toHaveCount(1);
  }
  await closeDetails(page);
  await openSavedChanges(page);
}
async function approve(page) {
  await openSavedChanges(page);
  await expect(approval(page)).toBeEnabled();
  expect((await savedLifecycle(page, page.url())).approved).toBe(false);
  await expect(studio(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await approval(page).click();
  await expect(studio(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
}
async function inspectActive(page, label) {
  await closeDetails(page);
  const view = studio(page).getByRole('button', { name: 'View what’s in use', exact: true });
  if (await view.isVisible()) {
    await view.click();
    const active = studio(page).getByRole('article', { name: 'Version in use' });
    await active.getByText('Saved version details', { exact: true }).click();
    await expect(active.getByText('Label: ' + label, { exact: true })).toBeVisible();
    expect((await savedLifecycle(page, page.url())).selection.revision.label).toBe(label);
  } else {
    await expect(studio(page).getByLabel('Customization status', { exact: true })).toContainText('On for my tasks');
    expect((await savedLifecycle(page, page.url())).selection.revision.label).toBe(label);
  }
}
async function expectOff(page) {
  expect((await savedLifecycle(page, page.url())).selection.revision).toBe(null);
  await closeDetails(page);
  await expect(studio(page).getByRole('log', { name: 'Studio conversation' }).getByText('This customization is off. Earlier tasks and receipts are kept.', { exact: true })).toBeVisible();
}
async function picture(page, name) {
  mkdirSync(resolve('build/screens'), { recursive: true });
  await studio(page).evaluate(node => {
    node.querySelector('.rs-canvas').scrollTop = 0;
  });
  if (page.viewportSize().width > 760) {
    expect(await studio(page).locator('.rs-composer').evaluate(form => form.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  }
  await page.screenshot({ path: resolve('build/screens', `${name}.png`), fullPage: true });
}

test('real task review separates typed assent, approval and use; native edits and other people survive', async ({ page, demo }) => {
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Unsaved lifecycle title');
  await open(page); await prepare(page);
  const ui = studio(page);
  await ui.getByLabel('Message to Daymark assistant').fill('Yes, use this customization');
  await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(decision(page).getByRole('region', { name: 'Checked proposed behavior', exact: true })).toContainText('Customer follow-up');
  await decision(page).getByRole('button', { name: 'Inspect examples and what’s in use', exact: true }).click();
  await expect(ui.getByRole('region', { name: 'Checked behavior currently in use', exact: true })).toContainText('Original follow-up');
  await closeDetails(page);
  expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await inspectActive(page, 'Original follow-up'); await closeDetails(page); await openSavedChanges(page);
  const project = (await nativeRequest(page, 'projects'))[0], nativeBefore = await nativeRequest(page, 'projects/' + project.id + '/tasks');
  await approval(page).click();
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  expect(await nativeRequest(page, 'projects/' + project.id + '/tasks')).toEqual(nativeBefore);
  await inspectActive(page, 'Original follow-up'); await closeDetails(page); await openSavedChanges(page);
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  expect(await nativeRequest(page, 'projects/' + project.id + '/tasks')).toEqual(nativeBefore);
  await inspectActive(page, 'Customer follow-up'); await picture(page, 'task-lifecycle-desktop');
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.locator('#open-customizations')).toBeFocused();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  await expect(page.getByRole('button', { name: /task advice/i })).toHaveCount(0);
  const completed = await completedTask(page, 'Matching lifecycle source');
  expect(completed.status.receipt.effect).toBe('CONFIRMED');
  expect((await nativeRequest(page, 'tasks/' + completed.status.receipt.value.id)).title).toBe('Customer follow-up');
  await open(page);
  await ui.getByLabel('Customization status').getByRole('button', { name: 'Turn off this customization', exact: true }).click(); await expectOff(page);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved lifecycle title');
  expect(await nativeRequest(page, 'tasks/' + completed.source.id + '/reaction')).toEqual(completed.status);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
  await expect(page.getByRole('button', { name: 'Plan the Saturday session', exact: true })).toBeVisible();
  const other = await completedTask(page, 'Other owner lifecycle source');
  expect(other.status.state).toBe('NO_BINDING'); expect(other.status.receipt).toBeNull();
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
});

test('lost activation response is read back before retry; historical evidence cannot approve a new draft', async ({ page, demo }) => {
  await enter(page, demo.origin); await open(page); await prepare(page); await approve(page);
  const ui = studio(page); let requests = 0;
  await page.route('**/api/extensions/*/activate', async route => { requests++; await route.fetch(); await route.abort('failed'); });
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await expect(ui.getByRole('status').filter({ hasText: 'Saved state reloaded' })).toBeVisible();
  await inspectActive(page, 'Customer follow-up'); expect(requests).toBe(1);
  await page.unroute('**/api/extensions/*/activate');
  await compileSaved(page);
  await reloadStudio(page); await latestExamples(page, true);
  await ui.locator('.rs-example-details > summary').click();
  await expect(ui.getByText(/Saved sample run · Earlier proposal/)).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
  await latestExamples(page, true); await expect(approval(page)).toHaveCount(0);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
  await page.reload(); await expect(ui).toBeVisible(); await latestExamples(page, true);
  await ui.locator('.rs-example-details > summary').click();
  await expect(ui.getByText(/Saved sample run · Earlier proposal/)).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
});

test('a held real reaction read survives a selection transition without replay or overwriting native edits', async ({ page, demo }) => {
  await enter(page, demo.origin); await page.getByRole('button', { name: 'Close task details' }).click();
  const project = (await nativeRequest(page, 'projects'))[0];
  const source = (await nativeRequest(page, 'projects/' + project.id + '/tasks')).find(task => task.title === 'Gather material references');
  await nativeRequest(page, 'tasks/' + source.id + '/complete', {});
  await expect.poll(async () => (await nativeRequest(page, 'tasks/' + source.id + '/reaction')).state).toBe('FINISHED');
  const original = await nativeRequest(page, 'tasks/' + source.id + '/reaction');
  expect(original.receipt.effect).toBe('CONFIRMED');
  await page.reload(); await tasks(page);
  let release, entered, delivered, held = false;
  const started = new Promise(resolve => { entered = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/' + source.id + '/reaction', async route => {
    if (held) return route.continue();
    held = true; const response = await route.fetch(); entered();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }).catch(() => {}); delivered();
  });
  try {
    await page.getByRole('button', { name: source.title, exact: true }).click(); await started;
    await page.getByLabel('Task title', { exact: true }).fill('Keep this edit');
    const before = await nativeRequest(page, 'projects/' + project.id + '/tasks');
    await open(page);
    await studio(page).getByLabel('Customization status').getByRole('button', { name: 'Turn off this customization', exact: true }).click(); await expectOff(page);
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    release(); await finished;
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this edit');
    await expect(page.getByRole('region', { name: 'Customization outcome', exact: true })).toContainText('Original follow-up');
    expect(await nativeRequest(page, 'tasks/' + source.id + '/reaction')).toEqual(original);
    expect(await nativeRequest(page, 'projects/' + project.id + '/tasks')).toEqual(before);
  } finally { release?.(); }
});

test('narrow Studio inspects current saved source and keeps a restored task choice after restart', async ({ page, demo }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await enter(page, demo.origin);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByLabel('Destination', { exact: true }).selectOption('customizations');
  const saved = await savedLifecycle(page, demo.origin);
  await page.getByRole('article', { name: saved.extension.name, exact: true }).getByRole('button', { name: /^(Open|Continue changes)$/ }).click();
  const ui = studio(page);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
  await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toContainText('keir/1');
  await expect(ui.getByLabel('Artifact pins for inspection', { exact: true })).toContainText('keir-dcm/1');
  await closeDetails(page);
  await ui.getByLabel('Customization status').getByRole('button', { name: 'Turn off this customization', exact: true }).click(); await expectOff(page);
  await openDetails(page); await ui.getByText('Manage saved customization', { exact: true }).click();
  const option = ui.getByLabel('Previously in use').locator('option').filter({ hasText: 'Original follow-up · customer approved' });
  await ui.getByLabel('Previously in use').selectOption(await option.getAttribute('value'));
  await expect(ui.getByText('This choice was approved for you.', { exact: false })).toBeVisible();
  expect((await savedLifecycle(page, demo.origin)).selection.revision).toBeNull();
  await ui.getByRole('button', { name: 'Restore Original follow-up for me', exact: true }).click();
  await inspectActive(page, 'Original follow-up'); await picture(page, 'task-lifecycle-narrow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await demo.restart(); await enter(page, demo.origin); await open(page); await inspectActive(page, 'Original follow-up');
});

test('a stale second-tab simulation and chat approval fail closed and reload the real proposal', async ({ page, context, demo }) => {
  await enter(page, demo.origin); await open(page); await prepare(page, 'Original follow-up');
  const other = await context.newPage();
  try {
    await other.goto(demo.origin);
    await other.getByRole('button', { name: 'Gather material references', exact: true }).click(); await open(other);
    await openSavedChanges(other);
    await expect(approval(other)).toBeEnabled();
    const stale = await savedLifecycle(other, demo.origin);
    await openSavedChanges(page);
    await expect(decision(page)).toBeVisible();
    await expect(studio(page).getByRole('separator')).toHaveCount(0);
    await prepare(page);
    const session = await (await other.request.get(demo.origin + '/api/session')).json();
    const rejected = await other.request.post(demo.origin + '/api/extensions/' + stale.extension.id + '/simulate', { headers: { origin: demo.origin, 'x-session-context': session.contextToken }, data: { revisionId: stale.revisionId, draftVersion: stale.draftVersion } });
    expect(rejected.status()).toBe(409);
    const approvals = [];
    other.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/approve')) approvals.push(request); });
    await approval(other).click();
    await expect(studio(other).getByRole('alert').filter({ hasText: 'The saved change or its approval changed' })).toBeVisible();
    expect(approvals).toEqual([]);
    expect((await savedLifecycle(other, demo.origin)).approved).toBe(false);
    await openSavedChanges(other);
    await expect(decision(other)).toContainText('Customer follow-up'); await inspectActive(other, 'Original follow-up');
  } finally { await other.close(); }
});

test('an ineligible saved task selection stays unavailable and can be turned off', async ({ page, demo }) => {
  await enter(page, demo.origin); demo.invalidateSelected(); await open(page);
  const ui = studio(page);
  await expect(ui.getByLabel('Customization status')).toContainText('Couldn’t check what’s in use');
  expect((await savedLifecycle(page, demo.origin)).selection.eligible).toBe(false);
  await expect(ui.getByLabel('Customization status').getByText('On for my tasks', { exact: true })).toHaveCount(0);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
  const source = await completedTask(page, 'Unavailable selected task contract', false);
  expect(source.status.state).toBe('PENDING'); expect(source.status.outcome).toBeNull(); expect(source.status.receipt).toBeNull();
  await open(page);
  await ui.getByLabel('Customization status').getByRole('button', { name: 'Turn off this customization', exact: true }).click(); await expectOff(page);
  expect((await nativeRequest(page, 'tasks/' + source.source.id + '/reaction')).state).toBe('PENDING');
});

async function nativeRequest(page, path, data) {
  const origin = new URL(page.url()).origin;
  const { contextToken } = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request[data === undefined ? 'get' : 'post'](origin + '/api/' + path, {
    headers: { origin, 'x-session-context': contextToken }, ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function completedTask(page, title, wait = true) {
  const project = (await nativeRequest(page, 'projects'))[0];
  const source = await nativeRequest(page, 'tasks', { projectId: project.id, title });
  await nativeRequest(page, 'tasks/' + source.id + '/complete', {});
  if (wait) await expect.poll(async () => (await nativeRequest(page, 'tasks/' + source.id + '/reaction')).state).toMatch(/^(FINISHED|NO_BINDING)$/);
  return { source, status: await nativeRequest(page, 'tasks/' + source.id + '/reaction') };
}
async function authoredFixture(page, title = 'Different task follow-up') {
  const projects = await nativeRequest(page, 'projects');
  return taskCustomizationFixture({ projectId: projects[0].id, otherProjectId: 'other-project-example', title });
}
async function expectedExample(page, matching = true) {
  const fixture = await authoredFixture(page), scenario = JSON.parse(fixture.cases[0]);
  if (!matching) {
    scenario.expect.outcome.result.status = 'NO_OP';
    scenario.expect.consumption.result.status = 'NO_OP';
  }
  return JSON.stringify(scenario);
}

async function reloadStudio(page) {
  await openDetails(page);
  await studio(page).getByRole('button', { name: 'Reload saved state', exact: true }).click();
  await expect(studio(page).getByLabel('Customization status', { exact: true })).toBeVisible();
  await closeDetails(page);
}
async function lifecyclePost(page, operation, data, origin = new URL(page.url()).origin) {
  const base = new URL(origin).origin, saved = await savedLifecycle(page, base);
  const { contextToken } = await (await page.request.get(base + '/api/session')).json();
  const response = await page.request.post(base + '/api/extensions/' + saved.extension.id + '/' + operation, {
    headers: { 'x-session-context': contextToken, origin: base }, data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function compileSaved(page, cases) {
  const saved = await savedLifecycle(page, page.url());
  const compiled = await lifecyclePost(page, 'compile', { hookId: TASK_HOOK, source: (await authoredFixture(page)).source, label: 'Different task follow-up', draftVersion: saved.draftVersion });
  if (!cases) return compiled;
  return lifecyclePost(page, 'scenarios', { revisionId: compiled.draft.id, cases: [cases], draftVersion: compiled.draftVersion });
}

for (const width of [1440, 390]) test(`real authored source, independent examples and saved-task activation ${width}`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await enter(page, demo.origin);
  await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved authored title');
  await open(page);
  const ui = studio(page);
  const compiled = await compileSaved(page);
  await reloadStudio(page);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
  await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText((await authoredFixture(page)).source);
  await expect(ui.getByText('Independent examples have not been saved for this source.', { exact: true })).toBeVisible();
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
  const session = await (await page.request.get(demo.origin + '/api/session')).json();
  const unchecked = await page.request.post(demo.origin + '/api/extensions/' + compiled.extension.id + '/simulate', { headers: { origin: demo.origin, 'x-session-context': session.contextToken }, data: { revisionId: compiled.revisionId, draftVersion: compiled.draftVersion } });
  expect(unchecked.status()).toBe(409); await expect(approval(page)).toHaveCount(0);
  await lifecyclePost(page, 'scenarios', { revisionId: compiled.draft.id, cases: [await expectedExample(page, false)], draftVersion: compiled.draftVersion });
  const failed = await checkSaved(page); expect(failed.evidence.passed).toBe(false);
  await latestExamples(page);
  await expect(ui.getByText('This example needs a correction', { exact: true })).toBeVisible();
  await expect(approval(page)).toHaveCount(0);
  const mismatch = await savedLifecycle(page, demo.origin);
  await lifecyclePost(page, 'scenarios', { revisionId: mismatch.draft.id, cases: [await expectedExample(page)], draftVersion: mismatch.draftVersion });
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  await expect(approval(page)).toBeEnabled();
  const proposed = decision(page).getByRole('region', { name: 'Checked proposed behavior', exact: true });
  await expect(proposed.locator('.rs-example:visible')).toHaveCount(1);
  await expect(proposed.getByText('Matches', { exact: true })).toBeVisible();
  await approve(page);
  expect((await savedLifecycle(page, demo.origin)).selection.revision.label).toBe('Original follow-up');
  await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved authored title');
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
  await expect(page.locator('.status-label.completed')).toHaveCount(0);
  const completed = await completedTask(page, 'Checked authored completion');
  expect(completed.status.receipt.effect).toBe('CONFIRMED');
  expect((await nativeRequest(page, 'tasks/' + completed.status.receipt.value.id)).title).toBe('Different task follow-up');
  await demo.restart(); await enter(page, demo.origin);
  expect((await savedLifecycle(page, demo.origin)).selection.revision.label).toBe('Different task follow-up');
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
  expect((await nativeRequest(page, 'tasks/' + completed.source.id + '/reaction')).outcome).toEqual(completed.status.outcome);
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
  await expect(page.getByRole('button', { name: 'Plan the Saturday session', exact: true })).toBeVisible();
  const other = await completedTask(page, 'Independent owner completion');
  expect(other.status.state).toBe('NO_BINDING'); expect(other.status.receipt).toBeNull();
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await expect(page.locator('.status-label.open')).toHaveText('○ Up next');
});

async function authoredReady(page, origin, waitForReview = true) {
  await enter(page, origin); await open(page);
  await compileSaved(page, await expectedExample(page));
  expect((await checkSaved(page)).evidence.passed).toBe(true);
  if (waitForReview) await expect(approval(page)).toBeEnabled();
  return studio(page);
}
async function savedLifecycle(page, origin) {
  const base = new URL(origin).origin;
  const { contextToken } = await (await page.request.get(base + '/api/session')).json();
  const response = await page.request.get(base + '/api/extensions', { headers: { 'x-session-context': contextToken } });
  expect(response.ok()).toBe(true);
  const collection = await response.json();
  expect(collection.items).toHaveLength(1);
  const state = await page.request.get(base + '/api/extensions/' + collection.items[0].extension.id, { headers: { 'x-session-context': contextToken } });
  expect(state.ok()).toBe(true);
  return state.json();
}

test('exact authored review shows saved A, preserves unsent conversation B, and reloads A after re-entry', async ({ page, demo }) => {
  const ui = await authoredReady(page, demo.origin);
  const saved = await savedLifecycle(page, demo.origin);
  const conversationB = 'Unsaved conversation B: explain this proposal before changing it.';
  await ui.getByLabel('Message to Daymark assistant').fill(conversationB);
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText((await authoredFixture(page)).source);
  await expect(ui.getByLabel('Saved example 1 for approval', { exact: true })).toHaveText(await expectedExample(page));
  await expect(ui.getByLabel('Message to Daymark assistant')).toHaveValue(conversationB);
  await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  const approved = await savedLifecycle(page, demo.origin);
  expect(approved.draft.id).toBe(saved.draft.id);
  expect(approved.approvedEvidenceId).toBe(saved.evidence.id);
  await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
  await open(page);
  await expect(ui.getByLabel('Message to Daymark assistant')).toHaveValue('');
  await openSavedChanges(page);
  await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText((await authoredFixture(page)).source);
  await expect(ui.getByLabel('Saved example 1 for approval', { exact: true })).toHaveText(await expectedExample(page));
  await expect(ui.getByLabel('Message to Daymark assistant')).toHaveValue('');
});

test('exact authored review fails closed on unavailable or mismatched saved documents and can retry', async ({ page, demo }) => {
  let mode = 'unavailable';
  await page.route('**/api/extensions/*/revisions/*', async route => {
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    const response = await route.fetch(), saved = await response.json();
    await route.fulfill({ response, json: mode === 'revision' ? { ...saved, revisionId: 'wrong-revision' } : mode === 'suite' ? { ...saved, suiteDigest: 'wrong-suite' } : saved });
  });
  const ui = await authoredReady(page, demo.origin, false);
  for (const next of ['revision', 'suite', 'valid']) {
    await expect(decision(page).getByText(/exact saved change and its examples could not be confirmed/)).toBeVisible();
    await expect(approval(page)).toHaveCount(0);
    await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveCount(0);
    mode = next; await ui.getByRole('button', { name: 'Check saved results again', exact: true }).click();
  }
  await expect(approval(page)).toBeEnabled();
  await ui.getByText('Exact saved change and checks', { exact: true }).click();
  await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText((await authoredFixture(page)).source);
  expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
});

test('a held exact-source review cannot enter a different owner or a re-entered workspace', async ({ page, context, demo }) => {
  await enter(page, demo.origin); await open(page);
  const proposed = await compileSaved(page, await expectedExample(page));
  const sourceRoute = '**/api/extensions/' + proposed.extension.id + '/revisions/' + proposed.draft.id;
  let release, arrived, delivered, holdOldWorkspace = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route(sourceRoute, async route => {
    if (!holdOldWorkspace) return route.continue();
    const response = await route.fetch(); arrived(); await gate;
    try { await route.fulfill({ response }); } catch { /* Workspace replacement aborts the old read. */ }
    delivered();
  });
  const ui = studio(page), other = await context.newPage();
  try {
    expect((await checkSaved(page)).evidence.passed).toBe(true);
    await started; await expect(approval(page)).toHaveCount(0);
    await other.goto(demo.origin); await other.getByLabel('Demo person', { exact: true }).selectOption('leo');
    await expect(page.getByRole('button', { name: 'Continue as Leo' })).toBeVisible();
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveCount(0);
    holdOldWorkspace = false;
    await page.getByRole('button', { name: 'Continue as Leo' }).click();
    await page.getByLabel('Demo person', { exact: true }).selectOption('maya');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya'); await tasks(page);
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click(); await open(page);
    release(); await finished; await page.unroute(sourceRoute);
    expect((await savedLifecycle(page, demo.origin)).approved).toBe(false);
    await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
    await openSavedChanges(page);
    await expect(approval(page)).toBeEnabled();
    await ui.getByText('Exact saved change and checks', { exact: true }).click();
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText((await authoredFixture(page)).source);
    expect((await savedLifecycle(page, demo.origin)).approvedEvidenceId).toBe(null);
  } finally { release?.(); await other.close(); }
});

const cancellation = base.extend({
  controlled: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-author-cancel-')), db = openData(join(directory, 'app.sqlite'));
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const compiled = await compileTaskCustomization();
    const { extensionId } = admitTaskDraft(db, createLifecycle(db), { operationId: 'compiler-disconnect' });
    let mode = 'hold', started, child, closed = 0, compilations = 0;
    const begun = new Promise(resolve => { started = resolve; });
    const app = await createApp({ db, origin, compiler: { compile: async (bytes, { signal }) => {
      compilations++;
      expect(Buffer.from(bytes).toString('utf8')).toBe(compiled.source);
      if (mode === 'immediate') return { artifact: compiled.artifactBytes, diagnostics: [] };
      // Real owned child tests HTTP/AbortSignal settlement; actual JAR behavior is covered separately.
      return new Promise((resolve, reject) => {
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        const stop = () => child.kill();
        signal.addEventListener('abort', stop, { once: true });
        child.once('spawn', () => { started(); if (signal.aborted) stop(); });
        child.once('error', reject);
        child.once('close', () => { closed++; signal.removeEventListener('abort', stop); reject(Object.assign(new Error('Cancelled fixture'), { status: 499 })); });
      });
    } } });
    await app.listen({ host: '127.0.0.1', port });
    try { await use({ origin, source: compiled.source, begun, get closed() { return closed; }, get compilations() { return compilations; },
      immediate() { mode = 'immediate'; }, saved: () => db.prepare('SELECT draft_version FROM extensions WHERE id=?').get(extensionId).draft_version }); }
    finally { if (child && child.exitCode === null && child.signalCode === null) child.kill(); await app.close(); db.close(); rmSync(directory, { recursive: true }); }
  },
});

// Authoring Stop controls are exercised in authoring.spec.mjs; this checks the native compiler disconnect boundary.
cancellation('real HTTP cancellation settles the compiler child and reads back before retry or after-commit claims', async ({ page, controlled }) => {
  await enter(page, controlled.origin);
  const { contextToken } = await (await page.request.get(controlled.origin + '/api/session')).json();
  const extensionId = (await savedLifecycle(page, controlled.origin)).extension.id;
  async function beginCompile() {
    await page.evaluate(({ token, extensionId, source }) => {
      window.compileController = new AbortController();
      window.compileResult = fetch('/api/extensions/' + extensionId + '/compile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': token },
        body: JSON.stringify({ hookId: 'TaskCompleted', source, draftVersion: 0 }), signal: window.compileController.signal }).catch(error => error.name);
    }, { token: contextToken, extensionId, source: controlled.source });
  }
  await beginCompile(); await controlled.begun;
  await page.evaluate(() => window.compileController.abort());
  await expect.poll(() => controlled.closed).toBe(1);
  expect(await page.evaluate(() => window.compileResult)).toBe('AbortError');
  expect((await savedLifecycle(page, controlled.origin)).draftVersion).toBe(0);
  expect(controlled.saved()).toBe(0);

  controlled.immediate();
  let committed, releaseResponse;
  const saved = new Promise(resolve => { committed = resolve; }), responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await page.route('**/api/extensions/*/compile', async route => {
    const response = await route.fetch(); committed(); await responseGate; await route.fulfill({ response }).catch(() => {});
  });
  try {
    await beginCompile(); await saved;
    expect(controlled.saved()).toBe(1);
    await page.evaluate(() => window.compileController.abort());
    expect(await page.evaluate(() => window.compileResult)).toBe('AbortError');
    const readback = await savedLifecycle(page, controlled.origin);
    expect(readback.draftVersion).toBe(1);
    expect(readback.draft.kind).toBe('authored');
    expect(controlled.compilations).toBe(2);
    expect(controlled.saved()).toBe(1);
  } finally { releaseResponse?.(); }
});
