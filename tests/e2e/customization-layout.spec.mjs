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
async function openDetails(page) {
  const collapsed = ui(page).locator('details.rs-tools:not([open]) > summary');
  if (await collapsed.count()) await collapsed.click();
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
async function openStudio(page) {
  await overview(page);
  await page.locator('#edit-task-advice').click();
  await expect(ui(page).getByRole('button', { name: 'Pending for open tasks', exact: true })).toBeEnabled();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function picture(page, name) {
  mkdirSync(resolve('build/screens'), { recursive: true });
  await page.screenshot({ path: resolve('build/screens', `daymark-${name}.png`), fullPage: true });
}
async function scrollTop(locator) { return locator.evaluate(node => node.scrollTop); }
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
  await expect(page.getByText('Powered by Keir', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(ui(page).getByRole('heading', { level: 1 })).toHaveText('Task advice Studio');
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
  await page.goto(demo.origin); await picture(page, 'welcome');
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await picture(page, 'tasks');
  await openStudio(page); await picture(page, 'studio-current');
  await ui(page).getByRole('button', { name: 'Needs attention for open tasks', exact: true }).click();
  await picture(page, 'studio-draft');
  await ui(page).getByRole('button', { name: 'Try on sample tasks', exact: true }).click();
  await expect(ui(page).getByRole('table').locator('tbody tr')).toHaveCount(6);
  await picture(page, 'studio-results');
  await ui(page).getByRole('button', { name: 'Review this advice', exact: true }).click();
  await picture(page, 'studio-review');
  await ui(page).getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
  await ui(page).getByRole('button', { name: 'Approve this advice', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'Use this advice for me', exact: true })).toBeFocused();
  await expect(ui(page).getByRole('button', { name: 'Use this advice for me', exact: true })).toBeInViewport();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  const card = page.getByRole('article', { name: 'Task advice customization' });
  await expect(card).toContainText('Approved · awaiting use: Needs attention');
  await expect(card).toContainText('Open tasks: Pending');
  await page.locator('#edit-task-advice').click();
  await ui(page).getByRole('button', { name: 'Use this advice for me', exact: true }).click();
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(card).toContainText('Current choice: Needs attention');
  await expect(card).not.toContainText('awaiting use');
  await picture(page, 'overview-in-use');
  demo.db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=(SELECT revision_id FROM extension_selections WHERE owner_id='maya')").run();
  await destination(page, 'Tasks'); await overview(page);
  await expect(card).toContainText('Unavailable');
  await expect(card).not.toContainText('completed tasks: Done');
  await picture(page, 'overview-unavailable');
  await page.getByLabel('Demo person').selectOption('sam'); await overview(page);
  await expect(card).toContainText('Off');
  await page.locator('#edit-task-advice').click();
  const current = ui(page).getByRole('article', { name: 'Current advice', exact: true });
  await expect(current).toContainText('Off');
  await expect(current.getByText('In use', { exact: true })).toHaveCount(0);
  await ui(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await expect(card).not.toContainText('Done');
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
  await main.focus(); const before = await scrollTop(main); await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTop(main)).toBeGreaterThan(before);
  const taskPosition = await scrollTop(main);
  await wheel(page, projects, 500); await expect.poll(() => scrollTop(projects)).toBeGreaterThan(200);
  expect(await scrollTop(main)).toBe(taskPosition);
  await projects.evaluate(node => node.scrollTop = node.scrollHeight); await wheel(page, projects, 600);
  expect(await scrollTop(main)).toBe(taskPosition); await bounded(page);
  await overview(page); await destination(page, 'Tasks');
  expect(await scrollTop(main)).toBe(taskPosition);
  await picture(page, 'native-overflow');
});

test('transcript and canvas own wheel and PageDown; arrivals preserve earlier reading and splitter keeps usable widths', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page);
  const log = ui(page).getByRole('log'), canvas = ui(page).locator('.rs-canvas'), composer = ui(page).locator('.rs-composer');
  const header = page.locator('.workspace-top'), rail = page.locator('.rail');
  for (let i = 0; i < 13; i++) {
    await ui(page).getByLabel('Message to Studio').fill(`Message ${i}: ${'Please explain this example. '.repeat(10)}`);
    await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
  }
  await expect(log.locator('article')).toHaveCount(27);
  await log.evaluate(node => node.scrollTop = 0);
  const geometry = { composer: await composer.boundingBox(), header: await header.boundingBox(), rail: await rail.boundingBox() };
  await wheel(page, log, 400); await expect.poll(() => scrollTop(log)).toBeGreaterThan(100);
  expect(await scrollTop(canvas)).toBe(0);
  await log.focus(); const before = await scrollTop(log); await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTop(log)).toBeGreaterThan(before);
  await log.evaluate(node => node.scrollTop = 0);
  await ui(page).getByLabel('Message to Studio').fill('A new message while reading earlier replies');
  await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui(page).getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
  expect(await scrollTop(log)).toBe(0);
  await openDetails(page);
  await ui(page).getByText('Manage saved advice', { exact: true }).click();
  await ui(page).getByText('Selection history and exact identities', { exact: true }).click();
  await wheel(page, canvas, 120); await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(50);
  expect(await scrollTop(log)).toBe(0);
  await canvas.focus(); const previewBefore = await scrollTop(canvas); await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(previewBefore);
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
    await page.setViewportSize(viewport); await enter(page, demo); await openStudio(page);
    const studio = ui(page), log = studio.getByRole('log'), composer = studio.getByLabel('Message to Studio');
    await composer.fill('Keep this unsent message');
    const composerBox = await studio.locator('.rs-composer').boundingBox();
    expect(composerBox.bottom ?? composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height);
    for (let i = 0; i < 5; i++) {
      await composer.fill(`Long example ${i} ${'explain this task '.repeat(14)}`); await studio.getByRole('button', { name: 'Send', exact: true }).click();
    }
    await composer.fill('Keep this unsent message');
    await log.evaluate(node => node.scrollTop = 0); await wheel(page, log, 300);
    await expect.poll(() => scrollTop(log)).toBeGreaterThan(0);
    const logPosition = await scrollTop(log);
    await picture(page, `studio-conversation-${viewport.width}x${viewport.height}`);
    await studio.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(studio.locator('.rs-chat')).toBeHidden();
    await openDetails(page);
    await studio.getByText('Manage saved advice', { exact: true }).click();
    await studio.getByText('Selection history and exact identities', { exact: true }).click();
    const canvas = studio.locator('.rs-canvas'); await wheel(page, canvas, 300);
    await expect.poll(() => scrollTop(canvas)).toBeGreaterThan(0); const canvasPosition = await scrollTop(canvas);
    await studio.getByRole('button', { name: 'Conversation', exact: true }).click();
    await expect(composer).toHaveValue('Keep this unsent message'); expect(await scrollTop(log)).toBe(logPosition);
    await studio.getByRole('button', { name: 'Preview', exact: true }).click(); expect(await scrollTop(canvas)).toBe(canvasPosition);
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
    await destination(page, 'Tasks'); await page.getByLabel('Demo person').selectOption('leo');
    await expect(page.getByRole('heading', { name: 'Neighbourhood workshop', exact: true })).toBeVisible();
    await page.getByLabel('Demo person').selectOption('maya');
    release(); await finished; await page.unroute('**/api/extensions');
    await expect(page.getByRole('article', { name: 'Task advice customization' })).toHaveCount(0);
    await overview(page); await expect(page.getByRole('article', { name: 'Task advice customization' })).toContainText('Read-only advice for Maya');
    await page.locator('#edit-task-advice').click();
    await expect(ui(page).getByRole('button', { name: 'Pending for open tasks', exact: true })).toBeEnabled();
    let releaseStudio, arrivedStudio;
    const studioStarted = new Promise(resolve => { arrivedStudio = resolve; });
    await page.route('**/api/extensions', async route => { const response = await route.fetch(); arrivedStudio(); await new Promise(resolve => { releaseStudio = resolve; }); try { await route.fulfill({ response }); } catch {} });
    await openDetails(page);
    await ui(page).getByRole('button', { name: 'Reload saved state', exact: true }).click(); await studioStarted;
    await destination(page, 'Tasks'); await page.getByLabel('Demo person').selectOption('leo');
    releaseStudio(); await page.unroute('**/api/extensions');
    await openStudio(page); await expect(ui(page).getByText('Advice for Leo', { exact: true })).toBeVisible();
    await expect(ui(page).getByRole('heading', { name: 'Pending', exact: true })).toHaveCount(0);
  } finally { release?.(); }
});

test('a newly produced real sample run does not replace historical evidence being read', async ({ page, demo }) => {
  await enter(page, demo); await openStudio(page);
  const studio = ui(page);
  await studio.getByRole('button', { name: 'Needs attention for open tasks', exact: true }).click();
  await studio.getByRole('button', { name: 'Try on sample tasks', exact: true }).click();
  await expect(studio.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  const original = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await (await fetch('/api/extensions', { headers: { 'X-Session-Context': session.contextToken } })).json()).evidence.id;
  });
  await studio.getByRole('button', { name: 'Pending for open tasks', exact: true }).click();
  let release, arrived, delivered;
  const started = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/extensions/simulate', async route => {
    const response = await route.fetch();
    expect((await response.json()).evidence.id).not.toBe(original);
    arrived(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }); delivered();
  });
  try {
    await studio.getByRole('button', { name: 'Try on sample tasks', exact: true }).click(); await started;
    await studio.getByRole('button', { name: 'Sample results', exact: true }).click();
    const results = studio.getByRole('article', { name: 'Sample results', exact: true });
    const content = await results.getByRole('table').textContent();
    await results.getByText('Saved run identity', { exact: true }).click();
    await expect(results).toContainText(`Evidence: ${original}`);
    const canvas = studio.locator('.rs-canvas'); await wheel(page, canvas, 400); const position = await scrollTop(canvas);
    release(); await finished;
    await expect(studio.getByRole('button', { name: 'Try on sample tasks', exact: true })).toHaveCount(0);
    await expect(studio.getByRole('status')).toContainText('A new sample run was saved.');
    expect(await results.getByRole('table').textContent()).toBe(content);
    await expect(results).toContainText(`Evidence: ${original}`);
    expect(await scrollTop(canvas)).toBe(position);
    await studio.getByRole('button', { name: 'Advice', exact: true }).click();
    await studio.getByRole('button', { name: 'Open current sample results', exact: true }).click();
    await expect(results).toContainText('Saved sample run · Current proposal');
    expect(await results.getByRole('table').textContent()).not.toBe(content);
  } finally { release?.(); }
});
