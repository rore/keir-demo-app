import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { seedTaskEffectBinding } from '../fixtures/task-effect-schema.mjs';

const navigation = page => page.getByRole('navigation', { name: 'Main navigation' });
const card = (page, id) => page.locator('.customization-card').filter({ has: page.locator('#edit-' + id) });
async function collection(page) {
  const mobile = page.getByLabel('Destination', { exact: true });
  if (await mobile.isVisible()) await mobile.selectOption('customizations');
  else await navigation(page).getByRole('button', { name: 'Customizations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
}
async function enter(page, fixture) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('maya');
}
async function api(page, path, body, status = 200) {
  const response = await page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const result = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, value: await result.json() };
  }, { path, body });
  expect(response.status, JSON.stringify(response.value)).toBe(status);
  return response.value;
}
const deletionBody = state => ({ expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation });
function selectSavedTaskCustomization(db) {
  const lifecycle = createLifecycle(db), { extensionId, revisionId, pins } = seedTaskEffectBinding(db);
  const state = lifecycle.state('maya', extensionId);
  return lifecycle.activate('maya', { extensionId, revisionId, draftVersion: state.draftVersion,
    generation: state.selection.generation, evidenceId: pins.approvedEvidenceId }, () => {}).extension;
}

for (const width of [1440, 390]) test(`named confirmation cancels without a request and deletes the selected item at width ${width}`, async ({ page }, testInfo) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const mutations = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/delete')) mutations.push(request.postDataJSON()); });
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await page.setViewportSize({ width, height: 900 }); await enter(page, fixture);
    const state = await api(page, 'extensions/' + item.id), beforeTasks = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const taskSelection = (await api(page, 'extensions')).selection;
    expect(taskSelection.revision.extensionId).toBe(item.id);
    await collection(page); const saved = card(page, item.id), remove = saved.getByRole('button', { name: 'Delete', exact: true });
    await remove.click(); const confirm = saved.locator('#customization-delete-confirm');
    await expect(confirm).toBeFocused(); await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(saved.getByText('Deleting this customization also clears its saved selection.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png'), fullPage: true });
    await confirm.press('Escape'); await expect(remove).toBeFocused(); expect(mutations).toEqual([]);
    await remove.click(); await saved.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(mutations).toEqual([]); expect(await api(page, 'extensions/' + item.id)).toEqual(state);
    await remove.click(); await confirm.press('Enter');
    await expect(saved).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeFocused();
    expect(mutations).toEqual([deletionBody(state)]);
    const current = await api(page, 'extensions');
    expect(current.selection).toMatchObject({ revision: null, generation: taskSelection.generation + 1 });
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(beforeTasks);
    await page.reload(); await collection(page); await expect(card(page, item.id)).toHaveCount(0);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('a task customization is authored, checked, approved, used and deleted through the real service UI', async ({ page }) => {
  const fixture = await startAuthoringFixture();
  try {
    await enter(page, fixture); await collection(page);
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const ui = page.getByRole('region', { name: 'Customization Studio', exact: true });
    await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill(`When I complete a task in ${fixture.metadata.projectName}, create ${fixture.metadata.title}. Other projects should create nothing.`);
    await ui.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill(`Confirmed: completing a task in ${fixture.metadata.projectName} should create ${fixture.metadata.title}; other projects should create nothing.`);
    await ui.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible();
    await openSavedChanges(page);
    await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    const approved = await api(page, 'extensions/' + id); expect(approved.approved).toBe(true); expect(approved.evidence.passed).toBe(true);
    const proof = await api(page, `extensions/${id}/evidence/${approved.evidence.id}`);
    expect(proof.reports).toHaveLength(6); expect(proof.reports.every(item => item.report.status === 'PASS')).toBe(true);
    await ui.getByRole('button', { name: /^(Turn on for my tasks|Switch to this customization)$/ }).click();
    await expect(ui.getByLabel('Customization status', { exact: true })).toContainText('On for my tasks');
    await expect(ui.getByLabel('Message to Daymark assistant', { exact: true })).toBeVisible();
    const active = await api(page, 'extensions/' + id); expect(active.selection.revision.id).toBe(approved.draft.id);
    const providerCalls = fixture.requests.length, native = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    await ui.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    const saved = card(page, id); await saved.getByRole('button', { name: 'Delete', exact: true }).click(); await saved.locator('#customization-delete-confirm').click();
    await expect(saved).toHaveCount(0); expect((await api(page, 'extensions')).selection.revision).toBeNull();
    await api(page, 'extensions/' + id, undefined, 404); expect(fixture.requests).toHaveLength(providerCalls);
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(native);
  } finally { await fixture.close(); }
});

test('stale confirmation requires a collection refresh and a new confirmation', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); await collection(page); const saved = card(page, item.id);
    await saved.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(saved.locator('#customization-delete-confirm')).toBeFocused();
    fixture.db.prepare('UPDATE extensions SET name=? WHERE id=?').run('A newer saved name', item.id);
    await saved.locator('#customization-delete-confirm').click();
    await expect(saved.getByRole('alert')).toContainText('confirm again');
    await expect(saved.locator('#customization-delete-confirm')).toBeDisabled();
    expect(fixture.db.prepare('SELECT deleted_at FROM extensions WHERE id=?').get(item.id).deleted_at).toBeNull();
    await saved.getByRole('button', { name: 'Refresh collection', exact: true }).click();
    await expect(saved.getByRole('heading', { name: 'A newer saved name', exact: true })).toBeVisible();
    await expect(saved.locator('#customization-delete-confirm')).toHaveCount(0);
    await saved.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(saved.locator('#customization-delete-confirm')).toHaveText('Delete “A newer saved name”');
    await saved.locator('#customization-delete-confirm').click(); await expect(saved).toHaveCount(0);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('busy feedback points to Stop and a foreign owner cannot delete the item', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); const state = await api(page, 'extensions/' + item.id); await collection(page);
    await page.route('**/api/extensions/*/delete', route => route.fulfill({ status: 409, json: { message: 'Stop first', code: 'CUSTOMIZATION_BUSY' } }));
    const saved = card(page, item.id); await saved.getByRole('button', { name: 'Delete', exact: true }).click();
    await saved.locator('#customization-delete-confirm').click();
    await expect(saved.getByRole('alert')).toContainText('use Stop'); await expect(saved.locator('#customization-delete-confirm')).toBeDisabled();
    await page.unroute('**/api/extensions/*/delete');
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam');
    await expect(page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('button', { name: 'A quieter workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam'); await collection(page);
    await expect(card(page, item.id)).toHaveCount(0); await api(page, `extensions/${item.id}/delete`, deletionBody(state), 404);
    expect(fixture.db.prepare('SELECT deleted_at FROM extensions WHERE id=?').get(item.id).deleted_at).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('a lost deletion response needs an explicit same-confirmation check and keeps one selection transition', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const bodies = []; let lose = true;
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); const state = await api(page, 'extensions/' + item.id); await collection(page);
    expect((await api(page, 'extensions')).selection.revision.extensionId).toBe(item.id);
    await page.route('**/api/extensions/*/delete', async route => {
      bodies.push(route.request().postDataJSON()); const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      if (lose) { lose = false; return route.abort('failed'); }
      return route.fulfill({ response });
    });
    const saved = card(page, item.id); await saved.getByRole('button', { name: 'Delete', exact: true }).click();
    await saved.locator('#customization-delete-confirm').click();
    await expect(saved.getByRole('alert')).toContainText('may have finished'); expect(bodies).toHaveLength(1);
    await saved.getByRole('button', { name: 'Check deletion', exact: true }).click(); await expect(saved).toHaveCount(0);
    expect(bodies).toEqual([deletionBody(state), deletionBody(state)]);
    expect((await api(page, 'extensions')).selection).toMatchObject({ revision: null, generation: state.selection.generation + 1 });
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

for (const kind of ['turn', 'resume']) test(`terminal ${kind} recovery reaches the deleted outcome and clears only its pending entry`, async ({ page }) => {
  const fixture = await startAuthoringFixture();
  const entryId = crypto.randomUUID(), unrelatedId = crypto.randomUUID(), operationId = crypto.randomUUID();
  try {
    await enter(page, fixture);
    let submitted = { target: { kind: 'create' }, conversationId: null, operationId,
      text: `When I complete a task in ${fixture.metadata.projectName}, create ${fixture.metadata.title}. Other projects should create nothing.`, expectedVersion: 0, expectedDraftVersion: 0 };
    let accepted = await api(page, 'authoring/turn', submitted, 202);
    await expect.poll(() => fixture.db.prepare('SELECT status FROM authoring_conversations WHERE id=?').get(accepted.conversation.id).status).not.toBe('RUNNING');
    let state = await api(page, 'extensions/' + accepted.conversation.extensionId);
    if (kind === 'resume') {
      const conversation = await api(page, 'authoring/conversations/' + accepted.conversation.id);
      submitted = { target: { kind: 'resume', extensionId: state.extension.id }, conversationId: conversation.id,
        operationId: crypto.randomUUID(), text: `Confirmed: completing a task in ${fixture.metadata.projectName} should create ${fixture.metadata.title}; other projects should create nothing.`, expectedVersion: conversation.version, expectedDraftVersion: state.draftVersion };
      accepted = await api(page, 'authoring/turn', submitted, 202);
      await expect.poll(() => fixture.db.prepare('SELECT status FROM authoring_conversations WHERE id=?').get(accepted.conversation.id).status).not.toBe('RUNNING');
      state = await api(page, 'extensions/' + state.extension.id);
    }
    await api(page, `extensions/${state.extension.id}/delete`, deletionBody(state));
    const key = `daymark-studio-work:maya:${entryId}`;
    const unrelatedKey = `daymark-studio-work:maya:${unrelatedId}`;
    const unrelated = { target: { kind: 'create' }, conversationId: null, operationId: crypto.randomUUID(), text: 'A separate pending request.', expectedVersion: 0, expectedDraftVersion: 0 };
    await page.evaluate(({ key, submitted, unrelatedKey, unrelated }) => { sessionStorage.setItem(key, JSON.stringify(submitted)); sessionStorage.setItem(unrelatedKey, JSON.stringify(unrelated)); }, { key, submitted, unrelatedKey, unrelated });
    const calls = []; page.on('request', request => { if (request.method() === 'POST') calls.push(new URL(request.url()).pathname); });
    const providerCalls = fixture.requests.length;
    await collection(page);
    const number = await page.evaluate(key => {
      const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(value => value.startsWith('daymark-studio-work:maya:'));
      return keys.indexOf(key) + 1;
    }, key);
    await page.getByRole('button', { name: 'Check submitted request ' + number, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Customization deleted', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: /Retry submitted/ })).toHaveCount(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    expect(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), unrelatedKey))).toEqual(unrelated);
    expect(calls).toEqual(['/api/authoring/recover']); expect(fixture.requests).toHaveLength(providerCalls);
    await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible(); await expect(card(page, state.extension.id)).toHaveCount(0);
  } finally { await fixture.close(); }
});

test('deletion keeps loaded earlier cards and leaves an unrelated selection unchanged', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const ids = Array.from({ length: 25 }, () => crypto.randomUUID());
  const insert = fixture.db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,creation_operation_id,creation_hash,draft_version,draft_revision_id) VALUES (?, ?, NULL, ?, ?, NULL, NULL, 0, NULL)');
  ids.forEach((id, index) => insert.run(id, 'maya', 'Saved discussion ' + index, Date.now() + index));
  try {
    const active = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); const selection = (await api(page, 'extensions')).selection; await collection(page);
    expect(selection.revision.extensionId).toBe(active.id);
    await expect(page.locator('.customization-card')).toHaveCount(20);
    await page.getByRole('button', { name: 'Load more customizations', exact: true }).click();
    await expect(page.locator('.customization-card')).toHaveCount(26);
    const saved = card(page, ids[0]); await saved.getByRole('button', { name: 'Delete', exact: true }).click();
    await saved.locator('#customization-delete-confirm').click(); await expect(saved).toHaveCount(0);
    await expect(page.locator('.customization-card')).toHaveCount(25);
    await expect(card(page, ids[1])).toBeVisible(); await expect(page.getByRole('button', { name: 'All customizations loaded', exact: true })).toBeVisible();
    expect((await api(page, 'extensions')).selection).toEqual(selection); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('an owner switch fences the late confirmation snapshot before any deletion is submitted', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let release, started, delivered;
  const hold = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { started = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; }), posts = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/delete')) posts.push(request.url()); });
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); await collection(page);
    await page.route('**/api/extensions/' + item.id, async route => {
      const response = await route.fetch(); started(); await hold;
      await route.fulfill({ response }).catch(() => {}); delivered();
    });
    await card(page, item.id).getByRole('button', { name: 'Delete', exact: true }).click(); await accepted;
    await expect(page.locator('.customization-delete')).toHaveCount(0);
    await page.getByLabel('Demo person', { exact: true }).selectOption('sam');
    await expect(page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('button', { name: 'A quieter workspace', exact: true })).toBeVisible();
    await collection(page); release(); await finished;
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('sam');
    await expect(card(page, item.id)).toHaveCount(0); await expect(page.locator('.customization-delete')).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(fixture.db.prepare('SELECT deleted_at FROM extensions WHERE id=?').get(item.id).deleted_at).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});

test('an owner switch fences a late deletion response and its confirmation', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let release, started;
  const hold = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { started = resolve; });
  try {
    const item = selectSavedTaskCustomization(fixture.db);
    await enter(page, fixture); await collection(page);
    await page.route('**/api/extensions/*/delete', async route => { const response = await route.fetch(); started(); await hold; await route.fulfill({ response }).catch(() => {}); });
    const saved = card(page, item.id); await saved.getByRole('button', { name: 'Delete', exact: true }).click(); await saved.locator('#customization-delete-confirm').click();
    await accepted;
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam'); release();
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam'); await collection(page);
    await expect(card(page, item.id)).toHaveCount(0); await expect(page.locator('.customization-delete')).toHaveCount(0);
    await expect(page.getByText(`“${item.name}” was deleted.`, { exact: true })).toHaveCount(0); expect(fixture.requests).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});
