import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-browser-'));
    const port = await freePort();
    let server = await start({ directory, port });
    try { await use({ origin: server.origin, get db() { return server.db; }, restart: async () => { await server.close(); server = await start({ directory, port }); } }); }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
test.use({ timezoneId: 'America/New_York' });
const pictures = resolve('build/screens');
async function screenshot(page, name) { mkdirSync(pictures, { recursive: true }); await page.screenshot({ path: join(pictures, `${name}.png`), fullPage: true }); }
async function signIn(page, name) {
  await page.getByRole('button', { name: `Continue as ${name}` }).click();
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue(name.toLowerCase());
  await expect(page.getByRole('status').filter({ hasText: 'Gathering your tasks' })).toHaveCount(0);
}
async function newProject(page, name, mobile = false) {
  await page.getByRole('button', { name: mobile ? 'Add project' : 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

const searchRequest = /\/api\/projects\/[^/]+\/tasks\/search(?:\?|$)/;
const searchHeading = page => page.getByRole('heading', { name: 'Search results', exact: true });
const taskButton = (page, name) => page.getByRole('button', { name, exact: true });
async function search(page, text, tag = '') {
  await page.getByLabel('Search tasks', { exact: true }).fill(text);
  await page.getByLabel('Filter by tag', { exact: true }).fill(tag);
  await taskButton(page, 'Search').click();
}

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, phone: { width: 390, height: 844 } })) {
  test(`native task fields persist across restart and search restores focus when a match is removed on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    demo.db.exec('UPDATE extension_selections SET revision_id = NULL, binding_pins = NULL');
    const studioCalls = [];
    page.on('request', request => {
      if (/^\/api\/(authoring|extensions)(\/|$)/.test(new URL(request.url()).pathname)) studioCalls.push(request.url());
    });
    await page.goto(demo.origin);
    await signIn(page, 'Maya');
    const task = taskButton(page, 'Gather material references');
    const tags = page.getByLabel('Tags', { exact: true });
    const priority = page.getByLabel('Priority', { exact: true });
    const dueTime = page.getByLabel('Due time (optional)', { exact: true });
    const detail = page.getByRole('dialog', { name: 'Task details' });
    await task.click();
    await expect(priority).toHaveValue('normal');
    await expect(dueTime).toHaveValue('');
    await tags.fill('  Material, priority, MATERIAL  ');
    await priority.selectOption('high');
    await dueTime.fill('2028-02-29T12:42:37.123');
    await taskButton(page, 'Save changes').click();
    await expect(detail).not.toBeVisible();
    await expect(task).toBeFocused();
    await expect(page.locator('time[datetime="2028-02-29T17:42:37.123Z"]')).toContainText('12:42:37.123 PM GMT-5');
    expect(demo.db.prepare("SELECT due_at FROM tasks WHERE title='Gather material references'").get().due_at).toBe('2028-02-29T17:42:37.123Z');
    await task.click();
    await expect(tags).toHaveValue('material, priority');
    await taskButton(page, 'Close task details').click();

    await demo.restart();
    expect(demo.db.prepare('SELECT count(*) AS n FROM extension_selections WHERE revision_id IS NOT NULL').get().n).toBe(0);
    await page.reload();
    await signIn(page, 'Maya');
    await search(page, '', ' PRIORITY ');
    await expect(searchHeading(page)).toBeVisible();
    await expect(task).toBeVisible();
    await screenshot(page, `native-tags-search-${layout}`);
    await task.click();
    await expect(tags).toHaveValue('material, priority');
    await expect(priority).toHaveValue('high');
    await expect(dueTime).toHaveValue('2028-02-29T12:42:37.123');
    await tags.fill('material');
    await dueTime.fill('');
    await taskButton(page, 'Save changes').click();
    await expect(detail).not.toBeVisible();
    await expect(page.getByText('No tasks match your search.', { exact: true })).toBeVisible();
    await expect(searchHeading(page)).toBeFocused();
    await taskButton(page, 'Clear').click();
    await expect(searchHeading(page)).toHaveCount(0);
    await expect(page.getByLabel('Filter by tag', { exact: true })).toHaveValue('');
    await task.click();
    await expect(tags).toHaveValue('material');
    await expect(priority).toHaveValue('high');
    await expect(dueTime).toHaveValue('');
    expect(studioCalls).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('literal text and exact tags page through open and completed tasks and retry the same cursor', async ({ page, demo }) => {
  const project = demo.db.prepare("SELECT id FROM projects WHERE owner_id='maya'").get().id;
  const insert = demo.db.prepare(`INSERT INTO tasks
    (id, owner_id, project_id, title, notes, status, created_at, updated_at, completed_at, tags)
    VALUES (?, 'maya', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = '2026-01-01T00:00:00.000Z';
  for (let i = 0; i < 25; i++) {
    const id = `match-${String(i).padStart(2, '0')}`;
    insert.run(id, project, `${id} %_`, '', 'open', now, now, null, '["review"]');
  }
  insert.run('match-25', project, 'A finished match', 'Notes contain %_', 'completed', now, now, now, '["review"]');
  insert.run('exclude-text', project, 'Text mismatch', '', 'open', now, now, null, '["review"]');
  insert.run('exclude-tag', project, 'Tag mismatch %_', '', 'open', now, now, null, '["review-later"]');

  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  const results = page.locator('[id^="task-open-match-"]:visible');
  const firstPage = Array.from({ length: 25 }, (_, index) => `task-open-match-${String(index).padStart(2, '0')}`);
  const rowIds = () => results.evaluateAll(rows => rows.map(row => row.id));
  await search(page, '%_', 'REVIEW');
  await expect.poll(rowIds).toEqual(firstPage);
  await expect(page.locator('[id^="task-open-exclude-"]:visible')).toHaveCount(0);

  const cursors = [];
  await page.route(searchRequest, route => {
    const cursor = new URL(route.request().url()).searchParams.get('after');
    if (!cursor) return route.continue();
    cursors.push(cursor);
    if (cursors.length === 1) return route.fulfill({ status: 503, json: { message: 'Try the next page again.' } });
    return route.continue();
  });
  await taskButton(page, 'Load more').click();
  await expect(page.getByRole('alert')).toContainText('Try the next page again.');
  expect(await rowIds()).toEqual(firstPage);
  await taskButton(page, 'Retry').click();
  await expect.poll(rowIds).toEqual([...firstPage, 'task-open-match-25']);
  expect(cursors).toEqual(['match-24', 'match-24']);
  await expect(taskButton(page, 'A finished match, completed')).toBeDisabled();
  await expect(taskButton(page, 'Load more')).toHaveCount(0);
  await taskButton(page, 'Clear').click();
  await expect(searchHeading(page)).toHaveCount(0);
  await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue('');
  await expect(taskButton(page, 'Text mismatch')).toBeVisible();
});

async function holdResponse(page, match) {
  let release, observed, delivered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { observed = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route(match, async route => {
    try {
      const response = await route.fetch();
      observed();
      await gate;
      try { await route.fulfill({ response }); }
      catch (error) { if (!route.request().failure()) throw error; }
    } finally { delivered(); }
  }, { times: 1 });
  return { started, async deliver() {
    release();
    await finished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } };
}

test('late native search responses cannot replace newer filter, project or owner results', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await newProject(page, 'Search sandbox');
  await page.getByLabel('New task title').fill('Second project task');
  await page.getByRole('button', { name: /^Add task/ }).click();
  await expect(taskButton(page, 'Second project task')).toBeVisible();
  const spring = page.getByRole('button', { name: /The spring collection$/ });
  const sandbox = page.getByRole('button', { name: /Search sandbox$/ });

  for (const scope of ['filter', 'project', 'owner']) {
    await spring.click();
    await expect(taskButton(page, 'Gather material references')).toBeVisible();
    const held = await holdResponse(page, searchRequest);
    await search(page, 'Gather');
    await held.started;
    const newerTask = {
      filter: 'Refine the packaging sketches',
      project: 'Second project task',
      owner: 'Plan the Saturday session',
    }[scope];
    try {
      if (scope === 'project') await sandbox.click();
      if (scope === 'owner') {
        await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
        await expect(page.getByRole('heading', { level: 1, name: 'Neighbourhood workshop' })).toBeVisible();
      }
      await search(page, newerTask);
      await expect(searchHeading(page)).toBeVisible();
      await expect(taskButton(page, newerTask)).toBeVisible();
    } finally { await held.deliver(); }
    await expect(taskButton(page, newerTask)).toBeVisible();
    await expect(taskButton(page, 'Gather material references')).toHaveCount(0);
    await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue(newerTask);
    await taskButton(page, 'Clear').click();
  }
});

test('native search refresh after a delayed save keeps newer search and detail drafts', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await search(page, 'e');
  const source = taskButton(page, 'Gather material references');
  const title = page.getByLabel('Task title', { exact: true });
  const searchText = page.getByLabel('Search tasks', { exact: true });
  await source.click();
  await title.fill('Alpha');
  const held = await holdResponse(page, /\/api\/tasks\/[^/?]+$/);
  await taskButton(page, 'Save changes').click();
  await held.started;
  try {
    await taskButton(page, 'Cancel').click();
    await searchText.fill('New unsent filter');
    await taskButton(page, 'Refine the packaging sketches').click();
    await title.fill('New unsaved task title');
  } finally { await held.deliver(); }
  await expect(source).toHaveCount(0);
  await expect(title).toHaveValue('New unsaved task title');
  await expect(searchText).toHaveValue('New unsent filter');
  await taskButton(page, 'Cancel').click();
  await taskButton(page, 'Clear').click();
  await expect(taskButton(page, 'Alpha')).toBeVisible();
});

test('a delayed metadata save merges normalized tags without overwriting newer edits in the same detail', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await taskButton(page, 'Gather material references').click();
  const title = page.getByLabel('Task title', { exact: true });
  const tags = page.getByLabel('Tags', { exact: true });
  const priority = page.getByLabel('Priority', { exact: true });
  const dueTime = page.getByLabel('Due time (optional)', { exact: true });
  await tags.fill(' New Tag, new tag ');
  await priority.selectOption('high');
  await dueTime.fill('2027-06-01T13:42');
  const held = await holdResponse(page, /\/api\/tasks\/[^/?]+$/);
  await taskButton(page, 'Save changes').click();
  await held.started;
  try {
    await title.fill('New unsaved title');
    await priority.selectOption('low');
    await dueTime.fill('2027-06-15T13:42:37.125');
  }
  finally { await held.deliver(); }
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await expect(title).toHaveValue('New unsaved title');
  await expect(tags).toHaveValue('new tag');
  await expect(priority).toHaveValue('low');
  await expect(dueTime).toHaveValue('2027-06-15T13:42:37.125');
  await taskButton(page, 'Cancel').click();
  await taskButton(page, 'Gather material references').click();
  await expect(title).toHaveValue('Gather material references');
  await expect(tags).toHaveValue('new tag');
  await expect(priority).toHaveValue('high');
  await expect(dueTime).toHaveValue('2027-06-01T13:42');
  expect(demo.db.prepare("SELECT due_at FROM tasks WHERE title='Gather material references'").get().due_at).toBe('2027-06-01T17:42:00.000Z');
});

for (const fallback of [false, true]) test(`local due time rejects gaps and repeated times with ${fallback ? 'the fallback' : 'native Temporal'}`, async ({ page, demo }) => {
  const saved = '2025-11-02T06:30:00.123Z';
  const task = demo.db.prepare("SELECT id FROM tasks WHERE title='Gather material references'").get();
  demo.db.prepare('UPDATE tasks SET due_at=? WHERE id=?').run(saved, task.id);
  const stored = () => demo.db.prepare('SELECT due_at FROM tasks WHERE id=?').get(task.id).due_at;
  const patches = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/tasks/' + task.id) patches.push(request.postDataJSON());
  });
  if (fallback) await page.addInitScript(() => Object.defineProperty(globalThis, 'Temporal', { configurable: true, value: undefined }));
  await page.goto(demo.origin);
  expect(await page.evaluate(() => typeof globalThis.Temporal)).toBe(fallback ? 'undefined' : 'object');
  await signIn(page, 'Maya');
  const open = taskButton(page, 'Gather material references');
  const save = taskButton(page, 'Save changes');
  const dueTime = page.getByLabel('Due time (optional)', { exact: true });
  const detail = page.getByRole('dialog', { name: 'Task details' });
  await expect(page.locator(`time[datetime="${saved}"]`)).toContainText('GMT-5');
  await open.click();
  await expect(dueTime).toHaveValue('2025-11-02T01:30:00.123');
  await expect(dueTime).toHaveAccessibleDescription(/America\/New_York.*GMT-5/);
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await save.click();
  await expect(detail).not.toBeVisible();
  expect(patches).toEqual([{ priority: 'high' }]);
  expect(stored()).toBe(saved);

  await open.click();
  await page.getByLabel('Notes (optional)', { exact: true }).fill('Keep this draft while correcting the time.');
  for (const [value, error] of [
    ['2025-03-09T02:30', 'This local time does not exist. Choose a different time.'],
    ['2025-11-02T01:30:00.123', 'This local time occurs twice. Choose a different time.'],
  ]) {
    await dueTime.fill(value);
    await save.click();
    await expect(detail.getByRole('alert')).toHaveText(error);
    await expect(dueTime).toHaveAccessibleDescription(new RegExp(error.replaceAll('.', '\\.')));
    await expect(dueTime).toBeFocused();
    expect(patches).toHaveLength(1);
    expect(stored()).toBe(saved);
  }
  await dueTime.fill('2025-03-09T03:30:00.456');
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await save.click();
  await expect(detail).not.toBeVisible();
  expect(patches.at(-1)).toMatchObject({ notes: 'Keep this draft while correcting the time.', dueAt: '2025-03-09T07:30:00.456Z' });
  expect(stored()).toBe('2025-03-09T07:30:00.456Z');
});

test('a saved due instant outside the local editor range survives unrelated edits and can be cleared', async ({ page, demo }) => {
  const saved = '0001-01-01T00:00:00.123Z';
  const task = demo.db.prepare("SELECT id FROM tasks WHERE title='Gather material references'").get();
  demo.db.prepare('UPDATE tasks SET due_at=? WHERE id=?').run(saved, task.id);
  const stored = () => demo.db.prepare('SELECT due_at FROM tasks WHERE id=?').get(task.id).due_at;
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  const open = taskButton(page, 'Gather material references');
  const detail = page.getByRole('dialog', { name: 'Task details' });
  const dueTime = page.getByLabel('Due time (optional)', { exact: true });
  await open.click();
  await expect(dueTime).toHaveValue('');
  await expect(dueTime).toHaveAccessibleDescription(/Saved time:.*BC.*GMT-/);
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await taskButton(page, 'Save changes').click();
  await expect(detail).not.toBeVisible();
  expect(stored()).toBe(saved);
  await open.click();
  await taskButton(page, 'Clear saved due time').click();
  await taskButton(page, 'Save changes').click();
  await expect(detail).not.toBeVisible();
  expect(stored()).toBeNull();
});

test('completion observations preserve edits and recover from failed or stale detail reads', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await page.getByRole('button', { name: 'Complete Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Task details', exact: true });
  const outcome = detail.getByRole('region', { name: 'Customization outcome', exact: true });
  const noBinding = 'No customization was recorded for this completion.';
  await expect(outcome.getByRole('status')).toHaveText(noBinding);
  await page.getByLabel('Task title', { exact: true }).fill('Unsaved title stays');
  await outcome.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(outcome.getByRole('status')).toHaveText(noBinding);
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved title stays');
  await page.route('**/api/tasks/*/reaction', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ message: 'The saved observation is temporarily unavailable.' }) }));
  await outcome.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(outcome.getByRole('alert')).toContainText('The customization result could not be checked. Your task stays completed.');
  await expect(outcome.getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved title stays');
  await page.unroute('**/api/tasks/*/reaction');
  let release, entered, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/*/reaction', async route => {
    const response = await route.fetch();
    expect(await response.json()).toEqual({ state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null, workflow: true });
    entered();
    await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { delivered(); }
  }, { times: 1 });
  await outcome.getByRole('button', { name: 'Check result', exact: true }).click();
  await started;
  await expect(outcome.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Newer unsaved title');
  await expect(outcome.getByRole('status')).toHaveText(noBinding);
  release(); await finished;
  await expect(outcome.getByRole('button', { name: 'Check result', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Newer unsaved title');
  await expect(outcome.getByRole('alert')).toHaveCount(0);
  await page.unroute('**/api/tasks/*/reaction');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await expect(page.getByRole('button', { name: 'Plan the Saturday session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Complete Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await expect(outcome.getByRole('status')).toHaveText(noBinding);
  await expect(outcome.getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toHaveCount(0);
  await screenshot(page, 'native-completion-outcome');
});

test('a completion observation pending across a user switch never enters the new workspace', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await signIn(page, 'Maya');
  await page.getByRole('button', { name: 'Complete Gather material references', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Customization outcome', exact: true }).getByRole('status')).toHaveText('No customization was recorded for this completion.');
  let release, entered, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks/*/reaction', async route => {
    const response = await route.fetch(); entered();
    await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { delivered(); }
  }, { times: 1 });
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await expect(page.getByRole('button', { name: 'Plan the Saturday session', exact: true })).toBeVisible();
  release();
  await finished;
  await page.unroute('**/api/tasks/*/reaction');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Plan the Saturday session');
  await expect(page.getByRole('dialog', { name: 'Task details', exact: true }).getByRole('region', { name: 'Customization outcome', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toHaveCount(0);
});

test('three people create, rename, edit and complete tasks; all data survives real server restart', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await expect(page.getByRole('heading', { name: 'Choose a demo person.', exact: true })).toBeVisible();
  await screenshot(page, 'welcome-desktop');
  for (const name of ['Maya', 'Leo', 'Sam']) {
    await signIn(page, name);
    if (name === 'Maya') await screenshot(page, 'tasks-desktop');
    await newProject(page, `${name} project`);
    await expect(page.getByText('Room for something good.')).toBeVisible();
    await page.getByRole('button', { name: 'Rename project' }).click();
    await page.getByLabel('Project name', { exact: true }).fill(`${name} notebook`);
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.getByLabel('New task title').fill(`${name} task`);
    await page.getByRole('button', { name: 'Add task', exact: false }).click();
    await page.getByRole('button', { name: `${name} task`, exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill(`${name} finished task`);
    await page.getByLabel('Notes (optional)').fill('A real saved note, without AI.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: `Complete ${name} finished task`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${name} finished task, completed`, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Continue as Maya' })).toBeVisible();
  }
  await demo.restart();
  await page.reload();
  for (const name of ['Maya', 'Leo', 'Sam']) {
    await signIn(page, name);
    await page.getByRole('button', { name: new RegExp(`${name} notebook$`) }).click();
    await expect(page.getByRole('button', { name: `${name} finished task, completed`, exact: true })).toBeVisible();
    for (const other of ['Maya', 'Leo', 'Sam'].filter(other => other !== name)) await expect(page.getByText(`${other} finished task`, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
});

test('mobile, keyboard/detail focus, empty, validation and API error states', async ({ page, demo }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo.origin); await signIn(page, 'Maya');
  await screenshot(page, 'tasks-mobile');
  const first = page.getByRole('button', { name: 'Gather material references', exact: true });
  await first.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(first).toBeFocused();
  await first.click(); await page.getByLabel('Task title', { exact: true }).fill(' ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('dialog [role=alert]')).toContainText('Task title must be 1');
  await screenshot(page, 'task-validation-mobile');
  await page.keyboard.press('Escape');
  await newProject(page, 'A blank page', true); await screenshot(page, 'empty-mobile');
  await page.route('**/api/tasks', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The local database could not be reached. Please try again.' }) }));
  await page.getByLabel('New task title').fill('Keep my draft'); await page.getByRole('button', { name: 'Add task', exact: false }).click();
  await expect(page.getByRole('alert')).toContainText('The local database could not be reached.');
  await expect(page.getByLabel('New task title')).toHaveValue('Keep my draft');
  await screenshot(page, 'api-error-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('delayed old data cannot repopulate a switched scope and expired API cannot clear a new cookie', async ({ page, context, demo }) => {
  await page.goto(demo.origin); await signIn(page, 'Maya');
  const oldScope = await page.evaluate(async () => (await fetch('/api/session')).json());
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/projects/*/tasks', async route => {
    const response = await route.fetch(); started(); await gate;
    try { await route.fulfill({ response }); } catch { /* The abandoned A request may already be aborted. */ }
  });
  await page.reload(); await intercepted;
  await expect(page.getByText('Gathering your tasks…')).toBeVisible(); await screenshot(page, 'loading-desktop');
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.unroute('**/api/projects/*/tasks'); release();
  await expect(page.getByRole('heading', { level: 1, name: 'Neighbourhood workshop' })).toBeVisible();
  await expect(page.getByText('Gather material references', { exact: true })).toHaveCount(0);
  const stale = await page.evaluate(async token => {
    const response = await fetch('/api/projects', { headers: { 'X-Session-Context': token } });
    return response.status;
  }, oldScope.contextToken);
  expect(stale).toBe(401);
  expect((await context.cookies()).find(cookie => cookie.name === 'keir_demo_session')).toBeTruthy();
  expect(await page.evaluate(async () => (await (await fetch('/api/session')).json()).user.id)).toBe('leo');
});

test('authentication transitions serialize across tabs even when the first cookie response is delayed', async ({ page, context, demo }) => {
  await page.goto(demo.origin); await signIn(page, 'Maya');
  const second = await context.newPage(); await second.goto(demo.origin);
  await expect(second.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('maya');
  // Finish initial owner reads before the deliberately delayed cookie transition.
  await expect(second.getByRole('button', { name: 'Gather material references', exact: true })).toBeVisible();
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { observed = resolve; });
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo'); await intercepted;
  await second.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam');
  await expect(second.getByRole('status').filter({ hasText: 'Opening your space' })).toBeVisible();
  release();
  await expect(second.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
  await expect(second.getByRole('heading', { level: 1, name: 'A quieter workspace' })).toBeVisible();
  expect(await second.evaluate(async () => (await (await fetch('/api/session')).json()).user.id)).toBe('sam');
  // Revoked initial reads and the cross-tab notification may report expiry in either order.
  await expect(page.getByRole('alert')).toContainText(/changed in another tab|session changed/);
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveCount(0);
  await screenshot(page, 'session-changed-desktop');
});

for (const nextTask of ['Refine the packaging sketches', 'Gather material references']) {
  test(`delayed save cannot close a newer panel draft: ${nextTask}`, async ({ page, demo }) => {
    await page.goto(demo.origin); await signIn(page, 'Maya');
    let release, observed;
    const gate = new Promise(resolve => { release = resolve; });
    const intercepted = new Promise(resolve => { observed = resolve; });
    await page.route('**/api/tasks/*', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Saved first task');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await intercepted;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: nextTask, exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Newer unsaved draft');
    const response = page.waitForResponse(response => response.request().method() === 'PATCH');
    release(); await response;
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Newer unsaved draft');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved first task', exact: true })).toBeVisible();
  });
}

test('initial project list must finish before project creation becomes available', async ({ page, demo }) => {
  await page.goto(demo.origin);
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { observed = resolve; });
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); observed(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await intercepted;
  try {
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  } finally { release(); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await newProject(page, 'Newest project');
  await expect(page.getByRole('button', { name: /Newest project$/ })).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { level: 1, name: 'Newest project', exact: true })).toBeVisible();
});
