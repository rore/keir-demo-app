import { test as base, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

// Public UI protocol fakes only. The isolated server has no configured provider.
const test = base.extend({
  demo: async ({}, use) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try { await use({ ...fixture, extensionId: fixture.db.prepare('SELECT id FROM extensions WHERE owner_id=?').get('maya').id }); }
    finally { await fixture.close(); }
  },
});
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const available = { available: true, code: null, provider: 'openai', model: 'offline-ui-fake' };
const reply = (route, json, status = 200) => route.fulfill({ status, json }).catch(error => { if (!route.request().failure()) throw error; });
const message = (id, text, role = 'assistant') => ({ id, text, role, kind: 'text' });
function discussion(state, id = 'current', version = 1, messages = [message('latest', 'Current exchange')]) {
  return { id, extensionId: state.extension.id, purpose: 'REVISE', version, status: 'AWAITING_USER', runId: `run-${version}`,
    operation: { id: `operation-${version}`, version, runId: `run-${version}` }, messages, messagesBefore: null, code: null, review: null,
    draft: { revisionId: state.draft?.id ?? null, draftVersion: state.draftVersion, suiteDigest: state.draft?.suiteDigest ?? null },
    selection: { revisionId: state.selection.revision?.id ?? null, generation: state.selection.generation } };
}
const summary = current => ({ id: current.id, extensionId: current.extensionId, purpose: current.purpose, version: current.version,
  status: current.status, runId: current.runId, creationOperationId: `creation-${current.id}`, operationId: current.operation.id });
async function signIn(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
}
async function api(page, origin, path) {
  const session = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request.get(origin + '/api/' + path, { headers: { origin, 'x-session-context': session.contextToken } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function collection(page) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
}
async function openItem(page, extensionId) {
  await collection(page);
  await page.locator(`[id="edit-${extensionId}"]`).click();
  await expect(studio(page)).toBeVisible();
}
async function details(page) {
  await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
}

test('ordinary edits exceed eight turns in one discussion and settings recovery has no discussion-count gate', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  let current = null, rejectSettings = false;
  const turns = [];
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/authoring' && request.method() === 'GET') return reply(route, { availability: available, current,
      conversations: Array.from({ length: 12 }, (_, index) => summary(discussion(saved, `saved-${index}`))), next: null });
    if (url.pathname === '/api/authoring/turn') {
      const body = request.postDataJSON(); turns.push(body);
      if (rejectSettings) return reply(route, { code: 'CONFIG_CHANGED', message: 'Settings changed' }, 409);
      current = discussion(saved, 'same-discussion', turns.length, [message(`answer-${turns.length}`, `Answer ${turns.length}`)]);
      current.operation = { id: body.operationId, version: body.expectedVersion + 1, runId: current.runId };
      return reply(route, { operation: current.operation, conversation: current }, 202);
    }
    return reply(route, current);
  });
  await openItem(page, demo.extensionId);
  const ui = studio(page), composer = ui.getByLabel('Message to Studio', { exact: true });
  for (let index = 1; index <= 12; index++) {
    await composer.fill(`Ordinary edit ${index}`);
    await composer.press('Enter');
    await expect(ui.getByText(`Answer ${index}`, { exact: true })).toBeVisible();
  }
  expect(turns[0].target.kind).toBe('revise');
  expect(turns.slice(1).every((turn, index) => turn.conversationId === 'same-discussion' && turn.target.kind === 'resume' && turn.expectedVersion === index + 1)).toBe(true);
  await expect(composer).toBeEnabled();
  rejectSettings = true;
  await composer.fill('Keep this settings-rejected message');
  await composer.press('Enter');
  const recovery = ui.getByRole('article', { name: 'Assistant settings changed', exact: true });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Start new conversation', exact: true })).toBeEnabled();
  await recovery.getByRole('button', { name: 'Start new conversation', exact: true }).click();
  await expect(composer).toHaveValue('Keep this settings-rejected message');
  expect(turns).toHaveLength(13);
});

test('collection pages merge summaries, keep global selection and expose more than eight recovery entries', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  await page.evaluate(() => {
    for (let index = 0; index < 10; index++) {
      sessionStorage.setItem(`daymark-studio-work:maya:${crypto.randomUUID()}`, JSON.stringify({ target: { kind: 'create' }, conversationId: null,
        operationId: crypto.randomUUID(), text: `Submitted request ${index}`, expectedVersion: 0, expectedDraftVersion: 0 }));
    }
  });
  const item = (id, excerpt) => ({ extension: { ...saved.extension, id, name: 'Untitled customization' }, draftVersion: 0, draft: null, approved: false, requestExcerpt: excerpt });
  const newer = item('newer', 'First exact original request'), another = item('another', 'Second exact original request');
  const pages = [], exactReads = [];
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/extensions/${demo.extensionId}`) exactReads.push(request.url()); });
  await page.route('**/api/extensions?**', route => {
    pages.push(new URL(route.request().url()).searchParams.get('before'));
    return reply(route, { owner: saved.owner, catalog: saved.catalog, selection: saved.selection, items: [newer,
      { extension: saved.extension, draftVersion: saved.draftVersion, draft: saved.draft, approved: saved.approved }], next: null });
  });
  await page.route('**/api/extensions', route => requestIsGet(route) ? reply(route, { owner: saved.owner, catalog: saved.catalog,
    selection: saved.selection, items: [newer, another], next: 'collection-older' }) : route.continue());
  await collection(page);
  await expect(page.getByRole('button', { name: /^Check submitted request / })).toHaveCount(10);
  await expect(page.locator('.customization-request')).toHaveCount(2);
  const load = page.getByRole('button', { name: 'Load more customizations', exact: true });
  await load.click();
  await expect(page.locator('.customization-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'All customizations loaded', exact: true })).toBeFocused();
  expect(pages).toEqual(['collection-older']);
  await expect(page.locator(`[id="edit-${demo.extensionId}"]`).locator('..')).toContainText('In use');
  await page.locator(`[id="edit-${demo.extensionId}"]`).click();
  await expect(studio(page)).toBeVisible();
  expect(exactReads).toHaveLength(1);
});
function requestIsGet(route) { return route.request().method() === 'GET'; }

test('older message and conversation pages preserve the current exchange, unsent input and reading position', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const current = { ...discussion(saved, 'chosen-current', 1, [message('latest', 'Current exchange'),
    ...Array.from({ length: 25 }, (_, index) => message(`recent-${index}`, `Recent message ${index}`))]), messagesBefore: 'messages-older' };
  const pages = [], turns = [];
  await page.route('**/api/authoring**', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { turns.push(request.url()); return reply(route, {}, 500); }
    if (url.pathname.endsWith('/messages')) {
      pages.push(url.searchParams.get('before'));
      return reply(route, { messages: Array.from({ length: 25 }, (_, index) => message(`old-${index}`, `Earlier message ${index}`)), next: null });
    }
    if (url.pathname === '/api/authoring') {
      if (url.searchParams.has('before')) return reply(route, { availability: available, current: discussion(saved, 'must-not-select'),
        conversations: [summary(discussion(saved, 'old-discussion'))], next: null });
      return reply(route, { availability: available, current: null, conversations: [summary(discussion(saved, 'page-first'))], next: 'discussions-older' });
    }
    return reply(route, current);
  });
  await page.goto(`${demo.origin}/#customization=${demo.extensionId}&conversation=chosen-current`);
  const ui = studio(page), composer = ui.getByLabel('Message to Studio', { exact: true });
  await expect(ui.getByText('Current exchange', { exact: true })).toBeVisible();
  await composer.fill('Keep this unsent input');
  const log = ui.getByRole('log', { name: 'Studio conversation', exact: true });
  await log.evaluate(element => { element.scrollTop = 0; });
  const readingTop = (await ui.getByText('Current exchange', { exact: true }).boundingBox()).y;
  await ui.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(ui.getByText(/^Earlier message /)).toHaveCount(25);
  expect(pages).toEqual(['messages-older']);
  await expect(log).toBeFocused();
  expect(Math.abs((await ui.getByText('Current exchange', { exact: true }).boundingBox()).y - readingTop)).toBeLessThan(3);
  await expect(composer).toHaveValue('Keep this unsent input');
  const bubbles = await ui.locator('.rs-message > p').allTextContents();
  expect(bubbles.indexOf('Earlier message 0')).toBeLessThan(bubbles.indexOf('Current exchange'));
  await details(page);
  await ui.getByRole('button', { name: 'Load earlier conversations', exact: true }).click();
  await expect(ui.getByLabel('Saved authoring conversation', { exact: true })).toHaveValue('chosen-current');
  expect(new URL(page.url()).hash).toContain('conversation=chosen-current');
  await expect(composer).toHaveValue('Keep this unsent input');
  expect(turns).toEqual([]);
});

test('Details discovers displaced history, sample runs, all revisions and only eligible restore choices', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const oldRevision = { ...saved.selection.revision, id: 'older-unused', label: 'Earlier unchecked changes' };
  const eligible = { ...saved.selection.revision, id: 'older-used', label: 'Previously used choice' };
  const calls = [];
  await page.route(`**/api/extensions/${demo.extensionId}**`, route => {
    const url = new URL(route.request().url()), path = url.pathname;
    calls.push(path + url.search);
    if (path.endsWith('/history')) return reply(route, { rows: [{ id: 1, generation: 1, operation: 'draft-superseded', revisionId: oldRevision.id, label: oldRevision.label }], next: null });
    if (path.endsWith('/evidence')) return reply(route, { rows: [{ id: 'older-run', revisionId: oldRevision.id }], next: null });
    if (path.endsWith('/restore-targets')) return reply(route, { rows: [eligible], next: null });
    if (path.endsWith('/revisions')) return reply(route, { rows: [oldRevision, eligible], next: null });
    return reply(route, { ...saved, history: Array.from({ length: 20 }, (_, index) => ({ id: 30 - index, generation: 1, operation: 'activate', revisionId: saved.selection.revision.id })),
      historyNext: 11, evidenceHistory: [{ id: 'recent-run', revisionId: saved.selection.revision.id }], evidenceHistoryNext: 'evidence-older', restoreTargets: [], restoreTargetsNext: 'restore-older' });
  });
  await openItem(page, demo.extensionId);
  const ui = studio(page);
  await details(page);
  await ui.getByText('Manage saved customization', { exact: true }).click();
  await ui.getByText('Selection history and exact identities', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load earlier selections', exact: true }).click();
  await expect(ui.getByRole('region', { name: 'Earlier saved changes', exact: true })).toContainText('Earlier unchecked changes');
  await ui.getByRole('button', { name: 'Load earlier restore choices', exact: true }).click();
  await expect(ui.getByLabel('Previously in use', { exact: true }).locator('option')).toHaveCount(2);
  await expect(ui.getByLabel('Previously in use', { exact: true })).not.toContainText('Earlier unchecked changes');
  await ui.getByText('All saved versions', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load saved versions', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Inspect saved version', exact: true })).toHaveCount(2);
  await ui.getByText('Saved sample runs', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load earlier sample runs', exact: true }).click();
  await expect(ui.getByRole('button', { name: /^Open saved sample run / })).toHaveCount(2);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/history?before=11`);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/evidence?before=evidence-older`);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/restore-targets?before=restore-older`);
});

test('a later status projection reopens a skipped message gap and inserts it in server order', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const numbered = index => message(`numbered-${index}`, `Ordered message ${index}`);
  let current = discussion(saved, 'same-history', 1, Array.from({ length: 20 }, (_, index) => numbered(index + 1)));
  const pages = [];
  await page.route('**/api/authoring**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      pages.push(url.searchParams.get('before'));
      return reply(route, { messages: Array.from({ length: 20 }, (_, index) => numbered(index + 20)), next: 'earlier-already-cached' });
    }
    if (url.pathname === '/api/authoring') return reply(route, { availability: available, conversations: [summary(current)], current, next: null });
    return reply(route, current);
  });
  await openItem(page, demo.extensionId);
  const ui = studio(page), composer = ui.getByLabel('Message to Studio', { exact: true });
  await expect(ui.getByText('Ordered message 2', { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
  await composer.fill('Keep this while another tab advances');
  current = { ...current, messages: Array.from({ length: 20 }, (_, index) => numbered(index + 40)), messagesBefore: 'skipped-gap' };
  await details(page);
  await ui.getByRole('button', { name: 'Check authoring status', exact: true }).click();
  await ui.getByRole('log', { name: 'Studio conversation', exact: true }).evaluate(element => { element.scrollTop = 0; });
  await expect(ui.getByText('Ordered message 1', { exact: true })).toBeInViewport();
  const readingTop = (await ui.getByText('Ordered message 1', { exact: true }).boundingBox()).y;
  await ui.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(ui.getByText(/^Ordered message /)).toHaveCount(59);
  expect(Math.abs((await ui.getByText('Ordered message 1', { exact: true }).boundingBox()).y - readingTop)).toBeLessThan(3);
  expect(await ui.locator('.rs-message > p').filter({ hasText: /^Ordered message / }).allTextContents()).toEqual(
    Array.from({ length: 59 }, (_, index) => `Ordered message ${index + 1}`));
  expect(pages).toEqual(['skipped-gap']);
  await expect(composer).toHaveValue('Keep this while another tab advances');
});

test('lost first-create response recovers its exact old receipt without searching the first discussion page or reposting', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  let posted, recoveries = 0;
  const current = discussion(saved, 'old-created-discussion', 30, [message('late', 'Recovered the original saved customization')]);
  await page.route('**/api/authoring**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/authoring') return reply(route, { availability: available, conversations: [], current: null, next: 'older-page' });
    if (path.endsWith('/turn')) { expect(posted).toBeUndefined(); posted = request.postDataJSON(); return route.abort('failed'); }
    if (path.endsWith('/recover')) {
      recoveries++; expect(request.postDataJSON()).toEqual(posted);
      return reply(route, { operation: { id: posted.operationId, version: 1, runId: 'original-run' }, conversation: current });
    }
    return reply(route, {}, 404);
  });
  await collection(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  const ui = studio(page);
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Original create request');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('Recovered the original saved customization', { exact: true })).toBeVisible();
  expect(posted.target).toEqual({ kind: 'create' });
  expect(recoveries).toBe(1);
  await expect(ui.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toContain(`customization=${demo.extensionId}`);
});

test('a collection page held across an owner switch cannot replace the new owner’s list', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  let release, entered;
  const held = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/extensions?**', async route => {
    entered(); await new Promise(resolve => { release = resolve; });
    await reply(route, { owner: saved.owner, selection: saved.selection, catalog: saved.catalog,
      items: [{ extension: { ...saved.extension, id: 'private-late', name: 'Late owner-private customization' }, draft: null, draftVersion: 0, approved: false }], next: null });
  });
  await page.route('**/api/extensions', async route => {
    const response = await route.fetch(), body = await response.json();
    return reply(route, { ...body, next: body.owner.id === 'maya' ? 'held-page' : null });
  });
  await collection(page);
  await page.getByRole('button', { name: 'Load more customizations', exact: true }).click();
  await held;
  await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
  await collection(page);
  release();
  await expect(page.locator('.customization-card').first()).toBeVisible();
  await expect(page.getByText('Late owner-private customization', { exact: true })).toHaveCount(0);
});

test('a lost guided-save receipt uses its exact creation lookup even when the saved item is absent from page one', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  let created, posts = 0;
  const exactLookups = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/extensions/creation/')) exactLookups.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/extensions', async route => {
    if (!requestIsGet(route)) {
      posts++;
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      created = await response.json();
      return route.abort('failed');
    }
    const response = await route.fetch(), body = await response.json();
    return reply(route, { ...body, items: body.items.filter(item => item.extension.id !== created?.extension.id), next: 'older-items' });
  });
  await collection(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  const ui = studio(page);
  await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
  await ui.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Continue checking this example', exact: true })).toBeEnabled();
  expect(posts).toBe(1);
  expect(exactLookups).toEqual([`/api/extensions/creation/${created.extension.creationOperationId}`]);
  expect(new URL(page.url()).hash).toContain(`customization=${created.extension.id}`);
  await expect(ui).toContainText('The saved example was found.');
  expect(demo.requests).toEqual([]);
});
