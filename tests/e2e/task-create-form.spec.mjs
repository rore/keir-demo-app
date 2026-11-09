import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';
import { resetData } from '../../src/data.mjs';

const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'task-create-browser-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let server = await start({ directory, port });
    server.db.exec('UPDATE extension_selections SET revision_id = NULL, binding_pins = NULL');
    try { await use({ origin: server.origin, get db() { return server.db; },
      restart: async () => { await server.close(); server = await start({ directory, port }); },
      reset: async () => { await server.close(); await resetData(directory, true); server = await start({ directory, port }); },
    }); }
    finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
test.use({ timezoneId: 'America/New_York' });

const button = (page, name) => page.getByRole('button', { name, exact: true });
const createDialog = page => page.getByRole('dialog', { name: 'New task', exact: true });
const fields = page => ({
  title: page.getByLabel('Task title', { exact: true }),
  notes: page.getByLabel('Notes (optional)', { exact: true }),
  tags: page.getByLabel('Tags', { exact: true }),
  priority: page.getByLabel('Priority', { exact: true }),
  dueTime: page.getByLabel('Due time (optional)', { exact: true }),
});
const first = { title: 'Prepare the brief', notes: '  Bring the reference notes.  ', tags: ' Client, review, CLIENT ', priority: 'high', dueTime: '2028-02-29T12:42:37.123' };
const newer = { title: 'Review the brief', notes: 'Keep these newer notes.', tags: 'next, review', priority: 'low', dueTime: '2028-03-01T09:10:11.456' };

async function signIn(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('maya');
  await expect(page.getByRole('status').filter({ hasText: 'Gathering your tasks' })).toHaveCount(0);
}
async function fillDraft(page, values) {
  const controls = fields(page);
  for (const [name, value] of Object.entries(values)) {
    if (name === 'priority') await controls[name].selectOption(value);
    else await controls[name].fill(value);
  }
}
async function expectDraft(page, values) {
  for (const [name, value] of Object.entries(values)) await expect(fields(page)[name]).toHaveValue(value);
  await expect(page.locator('#edit-due-zone')).toContainText('Time zone: America/New_York.');
}
async function holdCreateResponse(page, rejection) {
  let release, observed, delivered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { observed = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    try {
      const response = rejection ? null : await route.fetch();
      observed();
      await gate;
      try { await route.fulfill(rejection ? { status: 422, json: { operationId: route.request().headers()['x-task-create-id'], state: 'NOT_CREATED', code: 'RULE_DENIED', message: rejection } } : { response }); }
      catch (error) { if (!route.request().failure()) throw error; }
    } finally { delivered(); }
  }, { times: 1 });
  return { started, async deliver() {
    release();
    await finished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } };
}

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, narrow: { width: 320, height: 740 }, short: { width: 683, height: 384 } })) {
  test(`unsaved details retain fields on cancel and create through the native API on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    const count = () => demo.db.prepare("SELECT count(*) AS n FROM tasks WHERE owner_id='maya'").get().n;
    const before = count();
    await page.getByLabel('New task title', { exact: true }).fill(first.title);
    await button(page, 'Details').click();
    await expect(createDialog(page)).toBeVisible();
    await expect(fields(page).title).toBeFocused();
    await fillDraft(page, first);
    expect(count()).toBe(before);
    await button(page, 'Cancel').click();
    await expect(createDialog(page)).not.toBeVisible();
    await expect(button(page, 'Details')).toBeFocused();
    await button(page, 'Details').click();
    await expectDraft(page, first);
    expect(await createDialog(page).evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page)).not.toBeVisible();
    await expect(page.locator('.task-open').filter({ hasText: first.title })).toBeVisible();
    expect(count()).toBe(before + 1);
    const saved = demo.db.prepare('SELECT notes,tags,priority,due_at FROM tasks WHERE title=?').get(first.title);
    expect(saved).toEqual({ notes: first.notes, tags: '["client","review"]', priority: 'high', due_at: '2028-02-29T17:42:37.123Z' });
    await expect(page.getByLabel('New task title', { exact: true })).toHaveValue('');
    await page.getByLabel('New task title', { exact: true }).fill('An ordinary quick task');
    await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
    await expect(button(page, 'An ordinary quick task')).toBeVisible();
    expect(count()).toBe(before + 2);
  });

  test(`native validation keeps all creation fields and allows one corrected save on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await button(page, 'Details').click();
    const invalid = { ...first, tags: 'x'.repeat(33) };
    await fillDraft(page, invalid);
    const requests = [];
    page.on('request', request => { if (request.url().endsWith('/api/tasks') && request.method() === 'POST') requests.push(request); });
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    const summary = createDialog(page).getByRole('alert');
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('32');
    expect(requests).toHaveLength(0);
    await expectDraft(page, invalid);
    await expect(createDialog(page).locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(summary.getByRole('link')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('retained-create-fields.png') });
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(first.title).n).toBe(0);
    await fields(page).tags.fill(first.tags);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page)).not.toBeVisible();
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(first.title).n).toBe(1);

    await button(page, 'Details').click();
    await fillDraft(page, { ...first, title: 'A local time check', dueTime: '2028-11-05T01:30' });
    const creates = [];
    page.on('request', request => { if (request.url().endsWith('/api/tasks') && request.method() === 'POST') creates.push(request); });
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page).getByRole('alert')).toHaveText('This local time occurs twice. Choose a different time.');
    await expect(fields(page).dueTime).toBeFocused();
    expect(creates).toHaveLength(0);
  });

  test(`late native success preserves every newer draft field on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await button(page, 'Details').click();
    await fillDraft(page, first);
    const held = await holdCreateResponse(page);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await held.started;
    try { await fillDraft(page, newer); }
    finally { await held.deliver(); }
    await expect(createDialog(page)).toBeVisible();
    await expectDraft(page, newer);
    expect(demo.db.prepare('SELECT notes FROM tasks WHERE title=?').get(first.title).notes).toBe(first.notes);
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(newer.title).n).toBe(0);
    await expect(createDialog(page).getByRole('button', { name: 'Add task', exact: true })).toBeEnabled();
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page)).not.toBeVisible();
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title IN (?,?)').get(first.title, newer.title).n).toBe(2);
  });

  test(`late confirmed rejection preserves newer editable fields on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await button(page, 'Details').click();
    await fillDraft(page, first);
    const held = await holdCreateResponse(page, 'Add a due date for this client task.');
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await held.started;
    try { await fillDraft(page, newer); }
    finally { await held.deliver(); }
    await expect(createDialog(page).getByRole('alert')).toBeFocused();
    await expectDraft(page, newer);
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title IN (?,?)').get(first.title, newer.title).n).toBe(0);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page)).not.toBeVisible();
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(newer.title).n).toBe(1);
  });
}

test('plain quick-add errors open unsaved details without field hints or a task row', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const operationIds = [];
  page.on('request', request => { if (request.url().endsWith('/api/tasks') && request.method() === 'POST') operationIds.push(request.headers()['x-task-create-id']); });
  const title = 'Keep the exact quick title';
  const message = '<strong>Add a note</strong> before adding this task.';
  await page.route('**/api/tasks', route => route.fulfill({ status: 503,
    json: { operationId: route.request().headers()['x-task-create-id'], state: 'NOT_CREATED', code: 'CHECK_UNAVAILABLE', message } }), { times: 1 });
  await page.getByLabel('New task title', { exact: true }).fill(title);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  const summary = createDialog(page).getByRole('alert');
  await expect(summary).toHaveText(`Not added. ${message}`);
  await expect(summary).toBeFocused();
  await expect(summary.locator('strong,a,button')).toHaveCount(0);
  await expect(createDialog(page).locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(fields(page).title).toHaveValue(title);
  await expect(fields(page).notes).toBeEditable();
  expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(title).n).toBe(0);
  await fields(page).notes.fill('A corrected note.');
  await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(createDialog(page)).not.toBeVisible();
  expect(operationIds).toHaveLength(2);
  expect(operationIds[1]).not.toBe(operationIds[0]);
  expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(title).n).toBe(1);
});

test('late quick-add success preserves newer text and cannot reach another owner', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const quick = page.getByLabel('New task title', { exact: true });
  await quick.fill(first.title);
  let held = await holdCreateResponse(page);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  await held.started;
  try { await quick.fill(newer.title); }
  finally { await held.deliver(); }
  await expect(quick).toHaveValue(newer.title);
  await expect(button(page, first.title)).toBeVisible();

  held = await holdCreateResponse(page);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  await held.started;
  try {
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
    await expect(page.getByRole('heading', { name: 'Neighbourhood workshop', exact: true })).toBeVisible();
    await quick.fill('Another person’s unsent task');
  } finally { await held.deliver(); }
  await expect(quick).toHaveValue('Another person’s unsent task');
  await expect(button(page, newer.title)).toHaveCount(0);
  await expect(createDialog(page)).not.toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, narrow: { width: 320, height: 740 } })) {
  test(`unresolved readback enables only an explicit retry of the frozen attempt on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    const requests = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/tasks') && request.method() === 'POST') requests.push({ id: request.headers()['x-task-create-id'], body: request.postDataJSON() });
    });
    await page.route('**/api/tasks', route => route.abort('failed'), { times: 1 });
    await button(page, 'Details').click();
    await fillDraft(page, first);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(createDialog(page).getByRole('alert')).toContainText("We couldn't confirm whether this task was added.");
    await expect(button(page, 'Retry same attempt')).toHaveCount(0);
    await fillDraft(page, newer);
    await expect(createDialog(page).getByRole('button', { name: 'Add task', exact: true })).toBeDisabled();
    await button(page, 'Check result').click();
    await expect(button(page, 'Retry same attempt')).toBeEnabled();
    expect(requests).toHaveLength(1);
    expect(demo.db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n).toBe(0);
    await expectDraft(page, newer);
    await page.screenshot({ path: test.info().outputPath('unresolved-create-recovery.png') });
    await button(page, 'Retry same attempt').click();
    await expect(button(page, 'Check result')).toHaveCount(0);
    await expectDraft(page, newer);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(demo.db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n).toBe(1);
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(first.title).n).toBe(1);
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(newer.title).n).toBe(0);
  });
}

async function loseCommittedResponse(page) {
  let committed;
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch();
    committed = await response.json();
    await route.abort('failed');
  }, { times: 1 });
  return () => committed;
}

async function holdReadbackResponse(page) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), delivered = Promise.withResolvers();
  await page.route('**/api/task-create-operations/*', async route => {
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    try { await route.fulfill({ response }); } finally { delivered.resolve(); }
  }, { times: 1 });
  return { started: entered.promise, async deliver() {
    release.resolve();
    await delivered.promise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } };
}

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, narrow: { width: 320, height: 740 }, short: { width: 683, height: 384 } })) {
  test(`pending Add uses Close and late success keeps newer quick text on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await button(page, 'Details').click();
    await fillDraft(page, first);
    const held = await holdCreateResponse(page);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await held.started;
    try {
      const close = createDialog(page).getByRole('button', { name: 'Close', exact: true });
      await expect(close).toBeEnabled();
      await expect(createDialog(page).getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(createDialog(page).getByRole('status')).toHaveText("Adding… Closing this form won't stop the save.");
      await close.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('pending-add-close.png') });
      await close.click();
      await page.getByLabel('New task title', { exact: true }).fill(newer.title);
    } finally { await held.deliver(); }
    await expect(createDialog(page)).not.toBeVisible();
    await expect(page.getByLabel('New task title', { exact: true })).toHaveValue(newer.title);
    await expect(page.getByLabel('New task title', { exact: true })).toBeFocused();
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(first.title).n).toBe(1);
    expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(newer.title).n).toBe(0);
  });

  test(`confirmed readback focuses its in-form status when a recovery control disappears on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await loseCommittedResponse(page);
    await button(page, 'Details').click();
    await fillDraft(page, first);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(button(page, 'Check result')).toBeVisible();
    await expect(createDialog(page).getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
    await expect(createDialog(page).getByRole('status')).toHaveText("Closing this form won't stop the original save if it is still running.");
    await fillDraft(page, newer);
    let readbacks = 0;
    page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/task-create-operations/')) readbacks++; });
    const held = await holdReadbackResponse(page);
    await button(page, 'Check result').click();
    await held.started;
    await page.keyboard.press('Enter');
    expect(readbacks).toBe(1);
    await held.deliver();
    const confirmation = createDialog(page).getByRole('status');
    await expect(confirmation).toHaveText('The original task was added. Your newer changes are still here.');
    await expect(confirmation).toBeFocused();
    await expect(confirmation).toBeInViewport();
    await expectDraft(page, newer);
    await expect(button(page, 'Check result')).toHaveCount(0);
    await expect(createDialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('confirmed-recovery-focus.png') });
  });

  test(`confirmed readback keeps focus in a newer edit field on ${layout}`, async ({ page, demo }) => {
    await page.setViewportSize(viewport);
    await signIn(page, demo.origin);
    await loseCommittedResponse(page);
    await button(page, 'Details').click();
    await fillDraft(page, first);
    await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(button(page, 'Check result')).toBeVisible();
    await fillDraft(page, newer);
    const held = await holdReadbackResponse(page);
    await button(page, 'Check result').click();
    await held.started;
    try { await fields(page).notes.fill('Keep typing these newer notes.'); }
    finally { await held.deliver(); }
    await expect(createDialog(page).getByRole('status')).toHaveText('The original task was added. Your newer changes are still here.');
    await expect(fields(page).notes).toBeFocused();
    await expectDraft(page, { ...newer, notes: 'Keep typing these newer notes.' });
  });
}

test('lost create response survives native restart and reauthentication without replacing a later task edit', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await loseCommittedResponse(page);
  await button(page, 'Details').click();
  await fillDraft(page, first);
  await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(button(page, 'Check result')).toBeVisible();
  await fillDraft(page, newer);
  expect(saved().title).toBe(first.title);
  demo.db.prepare('UPDATE tasks SET title=?,notes=? WHERE id=?').run('A later saved title', 'Later saved notes', saved().id);
  const operation = demo.db.prepare('SELECT operation_id FROM task_create_operations').get().operation_id;
  await demo.restart();
  await button(page, 'Check result').click();
  await expect(page.getByRole('button', { name: 'Continue as Maya' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(createDialog(page)).toBeVisible();
  await expectDraft(page, newer);
  await button(page, 'Check result').click();
  await expect(button(page, 'Check result')).toHaveCount(0);
  await expectDraft(page, newer);
  await button(page, 'Cancel').click();
  await expect(page.locator('.task-open').filter({ hasText: 'A later saved title' })).toBeVisible();
  await expect(page.locator('.task-open').filter({ hasText: first.title })).toHaveCount(0);
  expect(demo.db.prepare('SELECT operation_id FROM task_create_operations').get().operation_id).toBe(operation);
  expect(demo.db.prepare('SELECT count(*) AS n FROM task_events WHERE source_task_id=?').get(saved().id).n).toBe(1);
});

test('recovered creation snapshot cannot restore a task that was deleted', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await loseCommittedResponse(page);
  await page.getByLabel('New task title', { exact: true }).fill(first.title);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  await expect(button(page, 'Check result')).toBeVisible();
  demo.db.prepare('DELETE FROM task_events WHERE source_task_id=?').run(saved().id);
  demo.db.prepare('DELETE FROM tasks WHERE id=?').run(saved().id);
  await button(page, 'Check result').click();
  await expect(createDialog(page)).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The original save was confirmed. This task is no longer available in this project.' })).toBeVisible();
  await expect(page.locator('.task-open').filter({ hasText: first.title })).toHaveCount(0);
  expect(demo.db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n).toBe(1);
  expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE id=?').get(saved().id).n).toBe(0);
});

test('real exclusive reset invalidates the retained project binding after reauthentication', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const originalProject = demo.db.prepare("SELECT id FROM projects WHERE owner_id='maya'").get().id;
  await page.route('**/api/tasks', route => route.abort('failed'), { times: 1 });
  await button(page, 'Details').click();
  await fillDraft(page, first);
  await createDialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(button(page, 'Check result')).toBeVisible();
  await demo.reset();
  expect(demo.db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(originalProject).n).toBe(0);
  await button(page, 'Check result').click();
  await expect(page.getByRole('button', { name: 'Continue as Maya' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The project for the previous task addition is no longer available.' })).toBeVisible();
  await expect(createDialog(page)).not.toBeVisible();
  await expect(page.getByLabel('New task title', { exact: true })).toHaveValue('');
  await button(page, 'Details').click();
  await expect(fields(page).title).toHaveValue('');
  await expect(button(page, 'Retry same attempt')).toHaveCount(0);
  await expect(button(page, 'Check result')).toHaveCount(0);
  expect(demo.db.prepare('SELECT count(*) AS n FROM task_create_operations').get().n).toBe(0);
  expect(demo.db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(first.title).n).toBe(0);
});

test('a mismatched terminal envelope cannot authorize a new attempt', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  await page.route('**/api/tasks', route => route.fulfill({ status: 422,
    json: { operationId: '00000000-0000-4000-8000-000000000000', state: 'NOT_CREATED', code: 'RULE_DENIED', message: 'Do not attach this message to another attempt.' } }), { times: 1 });
  await page.getByLabel('New task title', { exact: true }).fill(first.title);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  await expect(createDialog(page).getByRole('alert')).toHaveText("We couldn't confirm whether this task was added. Your entries are still here.");
  await expect(createDialog(page).getByRole('button', { name: 'Add task', exact: true })).toBeDisabled();
  await expect(button(page, 'Retry same attempt')).toHaveCount(0);
});

test('access rejection suspends unresolved recovery without authorizing another add', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  await page.route('**/api/tasks', route => route.abort('failed'), { times: 1 });
  await page.getByLabel('New task title', { exact: true }).fill(first.title);
  await page.locator('.quick-add').getByRole('button', { name: /^Add task/ }).click();
  await expect(button(page, 'Check result')).toBeVisible();
  await page.route('**/api/task-create-operations/*', route => route.fulfill({ status: 404, json: { message: 'That item is not available.' } }), { times: 1 });
  await button(page, 'Check result').click();
  await expect(createDialog(page).getByRole('alert')).toContainText('could not be checked with your current access');
  await expect(createDialog(page).getByRole('button', { name: 'Add task', exact: true })).toBeDisabled();
  await expect(button(page, 'Retry same attempt')).toHaveCount(0);
  await expect(fields(page).title).toHaveValue(first.title);
});
