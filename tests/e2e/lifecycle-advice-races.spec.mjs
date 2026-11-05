import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

// Native CRUD and real NO_BINDING receipts only; no artifact, qualification or effect registration.
const test = base.extend({
  demo: async ({}, use) => {
    const prefix = join(tmpdir(), 'keir-task-reaction-race-'), directory = mkdtempSync(prefix);
    const reservation = createServer();
    await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    let server;
    try {
      server = await start({ directory, port, staticRoot: resolve(process.env.KEIR_TEST_STATIC_ROOT ?? 'dist') });
      await use(server);
    } finally {
      await server?.close();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(resolve(directory).startsWith(resolve(prefix))).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  },
});
const details = page => page.getByRole('dialog', { name: 'Task details', exact: true });
const outcome = page => details(page).getByRole('region', { name: 'Customization outcome', exact: true });
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const noBinding = 'No customization was recorded for this completion.';
async function api(page, path) {
  const origin = new URL(page.url()).origin;
  const session = await (await page.request.get(origin + '/api/session')).json();
  return page.request.get(origin + '/api/' + path, { headers: { 'X-Session-Context': session.contextToken } });
}
async function openTaskForOwner(page) {
  const projects = await (await api(page, 'projects')).json();
  const tasks = await (await api(page, 'projects/' + projects[0].id + '/tasks')).json();
  const task = tasks.find(task => task.status === 'open');
  expect(task).toBeTruthy();
  return task;
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('maya');
  return openTaskForOwner(page);
}
async function complete(page, task) {
  const saved = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/tasks/' + task.id + '/complete');
  await page.getByRole('button', { name: 'Complete ' + task.title, exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ id: task.id, title: task.title, status: 'completed' });
  await expect(page.getByRole('button', { name: task.title + ', completed', exact: true })).toBeDisabled();
}
async function holdReaction(page, taskId) {
  let entered, release, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  const url = `**/api/tasks/${taskId}/reaction`;
  await page.route(url, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null });
    entered(); await gate;
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { delivered(); }
  }, { times: 1 });
  return { started, release, finished, url };
}
function recordMutations(page) {
  const writes = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/api\/(tasks|extensions|authoring)(\/|$)/.test(path)) writes.push(path);
  });
  return writes;
}
function snapshot(db) {
  return { tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    selections: db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all(),
    events: db.prepare('SELECT count(*) n FROM task_completion_events').get().n,
    receipts: db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n };
}
function unchangedExceptCompletion(demo, before, task) {
  const after = snapshot(demo.db);
  expect(after.tasks).toHaveLength(before.tasks.length);
  expect(after.tasks.filter(row => row.id !== task.id)).toEqual(before.tasks.filter(row => row.id !== task.id));
  expect(after.tasks.find(row => row.id === task.id)).toMatchObject({ title: task.title, status: 'completed' });
  expect(after.selections).toEqual(before.selections);
  expect(after.events).toBe(before.events + 1);
  expect(after.receipts).toBe(before.receipts);
  expect(demo.db.prepare('SELECT state,revision_id,pins,outcome FROM task_completion_events WHERE source_task_id=?').get(task.id))
    .toEqual({ state: 'NO_BINDING', revision_id: null, pins: null, outcome: null });
}

test('a held actual completion receipt cannot replace a reopened task view or unsent edits through Studio navigation', async ({ page, demo }) => {
  const task = await enter(page, demo.origin), before = snapshot(demo.db), writes = recordMutations(page);
  const hold = await holdReaction(page, task.id);
  try {
    await complete(page, task); await hold.started;
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await expect(outcome(page)).toContainText(noBinding);
    await details(page).getByLabel('Task title', { exact: true }).fill('Retain unsaved native race title');
    await details(page).getByLabel('Notes', { exact: false }).fill('Retain unsaved native notes');
    await details(page).getByRole('button', { name: 'Customizations', exact: true }).click();
    await expect(studio(page)).toBeVisible();
    await studio(page).getByRole('button', { name: 'Back to my task', exact: true }).click();
    await expect(details(page).getByRole('button', { name: 'Customizations', exact: true })).toBeFocused();
    await expect(details(page).getByLabel('Task title', { exact: true })).toHaveValue('Retain unsaved native race title');
    const notes = details(page).getByLabel('Notes', { exact: false });
    await expect(notes).toHaveValue('Retain unsaved native notes');
    await notes.focus();
    hold.release(); await hold.finished;
    await expect(notes).toBeFocused();
    await expect(notes).toHaveValue('Retain unsaved native notes');
    await expect(outcome(page)).toContainText(noBinding);
    await expect(outcome(page).getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
    await details(page).getByRole('button', { name: 'Close task details', exact: true }).click();
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await expect(details(page).getByLabel('Task title', { exact: true })).toHaveValue(task.title);
    await expect(outcome(page)).toContainText(noBinding);
    expect(writes).toEqual(['/api/tasks/' + task.id + '/complete']);
    unchangedExceptCompletion(demo, before, task);
  } finally { hold.release(); }
});

test('a held actual reaction response cannot enter another owner workspace after a cross-tab switch', async ({ page, context, demo }) => {
  const task = await enter(page, demo.origin), before = snapshot(demo.db), writes = recordMutations(page);
  await complete(page, task);
  const hold = await holdReaction(page, task.id), other = await context.newPage();
  try {
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await hold.started;
    await details(page).getByLabel('Task title', { exact: true }).fill('Private unsent Maya race edit');
    await other.goto(demo.origin);
    await other.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('button', { name: /^Continue as Leo/ })).toBeVisible();
    hold.release(); await hold.finished;
    await page.getByRole('button', { name: /^Continue as Leo/ }).click();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('leo');
    const leoTask = await openTaskForOwner(page);
    await page.getByRole('button', { name: leoTask.title, exact: true }).click();
    await expect(details(page).getByLabel('Task title', { exact: true })).toHaveValue(leoTask.title);
    await expect(outcome(page)).toHaveCount(0);
    await expect(page.getByText('Private unsent Maya race edit', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: task.title, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
    expect((await api(page, 'tasks/' + task.id + '/reaction')).status()).toBe(404);
    await details(page).getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(page.locator('#task-open-' + leoTask.id)).toBeFocused();
    expect(writes).toEqual(['/api/tasks/' + task.id + '/complete']);
    unchangedExceptCompletion(demo, before, task);
  } finally { hold.release(); await other.close(); }
});
