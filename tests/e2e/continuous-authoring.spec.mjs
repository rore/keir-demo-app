import { test as base, expect } from '@playwright/test';
import { openDeveloperTools, openSavedChanges } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

// Authoring projections are fakes; saved task source and proof use the actual compiler/simulator.
// The isolated server has no configured provider.
const test = base.extend({
  demo: async ({ page }, use) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      const lifecycle = createLifecycle(fixture.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
      const admit = (owner = 'maya', name = 'Completion follow-up') => admitTaskDraft(fixture.db, lifecycle, { owner, name });
      const { extensionId } = admit(), leo = admit('leo');
      let state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, source: fixture.metadata.source, draftVersion: 0 }, () => {});
      state = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.metadata.cases }, () => {});
      const input = { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion };
      state = await lifecycle.simulate('maya', input, () => {});
      expect(state.evidence.passed).toBe(true);
      state = lifecycle.approve('maya', { ...input, evidenceId: state.evidence.id }, () => {});
      lifecycle.activate('maya', { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
      // Each protocol case supplies its own discussion projection; host admission rows stay intact.
      await page.route('**/api/authoring**', route => reply(route, { availability: { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null },
        conversations: [], current: null, next: null }));
      await use({ ...fixture, extensionId, leoId: leo.extensionId, admit });
    }
    finally {
      // demo depends on page, so stop the client before closing its server.
      try { await page.close(); }
      finally { await fixture.close(); }
    }
  },
});
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const available = { available: true, code: null, provider: 'openai', model: 'offline-ui-fake' };
const reply = (route, json, status = 200) => route.fulfill({ status, json }).catch(error => { if (!route.request().failure()) throw error; });
const message = (id, text, role = 'assistant') => ({ id, text, role, kind: 'text' });
const transcript = (conversationId, messages, next = null) => ({ messages: messages.map(item => ({ ...item, conversationId })), next });
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
async function api(page, origin, path, body) {
  const session = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request.fetch(origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'x-session-context': session.contextToken }, ...(body === undefined ? {} : { data: body }) });
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
  await studio(page).getByRole('button', { name: 'More', exact: true }).click();
  await openDeveloperTools(page);
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
  const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
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
  await expect(ui.getByRole('alert')).toContainText('Assistant settings changed. Your message is kept.');
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
  const excerpts = page.locator('details.customization-discussion');
  await expect(excerpts).toHaveCount(2);
  for (const [index, excerpt] of (await excerpts.all()).entries()) {
    await expect(excerpt).toHaveJSProperty('open', false);
    await excerpt.getByText('Discussion started with', { exact: true }).click();
    await expect(excerpt.locator('p')).toHaveText(index ? 'Second exact original request' : 'First exact original request');
    await expect(excerpt.locator('p')).toBeVisible();
  }
  const load = page.getByRole('button', { name: 'Load more customizations', exact: true });
  await load.click();
  await expect(page.locator('.customization-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'All customizations loaded', exact: true })).toBeFocused();
  expect(pages).toEqual(['collection-older']);
  await expect(page.locator('.customization-card').filter({ has: page.locator(`[id="edit-${demo.extensionId}"]`) })).toContainText('In use');
  await page.locator(`[id="edit-${demo.extensionId}"]`).click();
  await expect(studio(page)).toBeVisible();
  expect(exactReads).toHaveLength(1);
});
function requestIsGet(route) { return route.request().method() === 'GET'; }

test('older transcript segments preserve the current exchange, unsent input and reading position', async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const current = { ...discussion(saved, 'chosen-current', 1, [message('latest', 'Current exchange'),
    ...Array.from({ length: 25 }, (_, index) => message(`recent-${index}`, `Recent message ${index}`))]), messagesBefore: 'messages-older' };
  const pages = [], turns = [];
  await page.route('**/api/authoring**', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { turns.push(request.url()); return reply(route, {}, 500); }
    if (url.pathname.endsWith('/transcript')) {
      pages.push(url.searchParams.get('before'));
      expect(url.searchParams.get('extensionId')).toBe(demo.extensionId);
      return reply(route, transcript('old-discussion', Array.from({ length: 20 }, (_, index) =>
        message(index === 0 ? 'latest' : `old-${index}`, `Earlier message ${index}`))));
    }
    if (url.pathname === '/api/authoring') {
      return reply(route, { availability: available, current, conversations: [summary(current)], next: null,
        transcript: transcript(current.id, current.messages, 'messages-older') });
    }
    return reply(route, current);
  });
  await page.goto(`${demo.origin}/#customization=${demo.extensionId}`);
  const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
  await expect(ui.getByText('Current exchange', { exact: true })).toBeVisible();
  await composer.fill('Keep this unsent input');
  const log = ui.getByRole('log', { name: 'Studio conversation', exact: true });
  await log.evaluate(element => { element.scrollTop = 0; });
  const readingTop = (await ui.getByText('Current exchange', { exact: true }).boundingBox()).y;
  await ui.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(ui.getByText(/^Earlier message /)).toHaveCount(20);
  expect(pages).toEqual(['messages-older']);
  await expect(log).toBeFocused();
  expect(Math.abs((await ui.getByText('Current exchange', { exact: true }).boundingBox()).y - readingTop)).toBeLessThan(3);
  await expect(composer).toHaveValue('Keep this unsent input');
  const bubbles = await ui.locator('.rs-message > p').allTextContents();
  expect(bubbles.indexOf('Earlier message 0')).toBeLessThan(bubbles.indexOf('Current exchange'));
  await details(page);
  await expect(ui.getByLabel('Saved authoring conversation', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#customization=' + demo.extensionId);
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
  await ui.getByText('Restore an earlier version', { exact: true }).click();
  await ui.getByText('Selection history and exact identities', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load earlier selections', exact: true }).click();
  await expect(ui.getByRole('region', { name: 'Earlier versions', exact: true })).toContainText('Earlier unchecked changes');
  await ui.getByRole('button', { name: 'Load earlier restore choices', exact: true }).click();
  await expect(ui.getByLabel('Previously in use', { exact: true }).locator('option')).toHaveCount(2);
  await expect(ui.getByLabel('Previously in use', { exact: true })).not.toContainText('Earlier unchecked changes');
  await ui.getByText('All versions', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load saved versions', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Inspect saved version', exact: true })).toHaveCount(2);
  await ui.getByText('Saved sample runs', { exact: true }).click();
  await ui.getByRole('button', { name: 'Load earlier sample runs', exact: true }).click();
  await expect(ui.getByRole('button', { name: /^Open saved sample run / })).toHaveCount(2);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/history?before=11`);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/evidence?before=evidence-older`);
  expect(calls).toContain(`/api/extensions/${demo.extensionId}/restore-targets?before=restore-older`);
});

test('a failed earlier page retries locally at the same cursor without disturbing current work or the open canvas', async ({ page, demo }, testInfo) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const recent = Array.from({ length: 20 }, (_, index) => message(`recent-${index}`, `Retained current message ${index}`));
  const current = { ...discussion(saved, 'retry-history', 1, recent), messagesBefore: 'retry-exact-page' };
  const pages = [], turns = [];
  await page.route('**/api/authoring**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') { turns.push(route.request().url()); return reply(route, {}, 500); }
    if (url.pathname.endsWith('/messages')) {
      pages.push(url.searchParams.get('before'));
      if (pages.length === 1) return reply(route, { message: 'Temporarily unavailable' }, 503);
      return reply(route, { messages: [message('earlier', 'Recovered earlier message'), recent[0]], next: 'next-older-page' });
    }
    if (url.pathname === '/api/authoring') return reply(route, { availability: available, current, conversations: [summary(current)], next: null });
    return reply(route, current);
  });
  await openItem(page, demo.extensionId);
  const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
  await expect(ui.getByText('Retained current message 0', { exact: true })).toBeVisible();
  await composer.fill('Keep this unsent correction');
  await details(page);
  const log = ui.getByRole('log', { name: 'Studio conversation', exact: true });
  await log.evaluate(element => { element.scrollTop = 0; });
  const currentMessage = ui.getByText('Retained current message 0', { exact: true });
  const readingTop = (await currentMessage.boundingBox()).y;
  await ui.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  const retry = ui.getByRole('button', { name: 'Retry earlier messages', exact: true });
  await expect(retry).toBeFocused();
  await expect(log.getByText('Couldn’t load earlier messages.', { exact: true })).toBeVisible();
  await expect(ui.getByRole('alert')).toHaveCount(0);
  await expect(ui.getByText(/^Retained current message /)).toHaveCount(20);
  expect(Math.abs((await currentMessage.boundingBox()).y - readingTop)).toBeLessThan(3);
  // Older history failed; the current discussion, unsent correction and open Details stay available.
  await page.screenshot({ path: testInfo.outputPath('earlier-messages-load-error.png'), fullPage: true });
  await retry.click();
  await expect(ui.getByText('Recovered earlier message', { exact: true })).toBeVisible();
  await expect(ui.getByText('Retained current message 0', { exact: true })).toHaveCount(1);
  await expect(ui.getByText('Couldn’t load earlier messages.', { exact: true })).toHaveCount(0);
  expect(pages).toEqual(['retry-exact-page', 'retry-exact-page']);
  expect(Math.abs((await currentMessage.boundingBox()).y - readingTop)).toBeLessThan(3);
  await expect(composer).toHaveValue('Keep this unsent correction');
  await expect(ui.locator('.rs-tools')).toBeVisible();
  await expect(ui.locator('.rs-preview')).toBeVisible();
  await expect(ui.locator('.sr-only[role="status"]')).toHaveText('Earlier messages loaded.');
  expect(new URL(page.url()).hash).toBe('#customization=' + demo.extensionId);
  expect(turns).toEqual([]);
});

for (const status of [200, 503]) test(`a late earlier-page ${status} response cannot enter another owner's Studio`, async ({ page, demo }) => {
  await signIn(page, demo.origin);
  const saved = await api(page, demo.origin, `extensions/${demo.extensionId}`);
  const current = { ...discussion(saved, 'owner-private-history'), messagesBefore: 'private-page' };
  let release, entered;
  const held = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/authoring**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      entered(); await new Promise(resolve => { release = resolve; });
      return reply(route, status === 200 ? { messages: [message('private', 'Late owner-private earlier message')], next: null } : { message: 'Late private failure' }, status);
    }
    if (url.pathname === '/api/authoring') return reply(route, { availability: available,
      current: url.searchParams.get('extensionId') === demo.extensionId ? current : null, conversations: [], next: null });
    return reply(route, current);
  });
  try {
    await openItem(page, demo.extensionId);
    await studio(page).getByLabel('Message to Daymark assistant', { exact: true }).fill('Private unsent correction');
    await studio(page).getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await held;
    await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('leo');
    await openItem(page, demo.leoId);
    release();
    await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('');
    await expect(studio(page).getByText('Late owner-private earlier message', { exact: true })).toHaveCount(0);
    await expect(studio(page).getByText('Couldn’t load earlier messages.', { exact: true })).toHaveCount(0);
    await expect(studio(page).getByRole('button', { name: 'Retry earlier messages', exact: true })).toHaveCount(0);
  } finally { release?.(); }
});

for (const approved of [false, true]) test(`a current context boundary owns recovery until its explicit continuation settles (${approved ? 'approved' : 'eligible'} proof)`, async ({ page, demo }, testInfo) => {
  await signIn(page, demo.origin);
  const admitted = demo.admit('maya', 'Retained checked proposal');
  let saved = await api(page, demo.origin, `extensions/${admitted.extensionId}/compile`, { hookId: TASK_HOOK, source: demo.metadata.source, draftVersion: 0 });
  const extensionId = saved.extension.id;
  saved = await api(page, demo.origin, `extensions/${extensionId}/scenarios`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases: demo.metadata.cases });
  saved = await api(page, demo.origin, `extensions/${extensionId}/simulate`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
  if (approved) saved = await api(page, demo.origin, `extensions/${extensionId}/approve`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, evidenceId: saved.evidence.id });
  const before = await api(page, demo.origin, `extensions/${extensionId}`);
  const review = { revisionId: saved.draft.id, draftVersion: saved.draftVersion, suiteDigest: saved.draft.suiteDigest, evidenceId: saved.evidence.id, eligible: true };
  const archived = { ...discussion(saved, 'archived-context-boundary'), status: 'BLOCKED', code: 'CONTEXT_LIMIT', review };
  let current = { ...discussion(saved, 'context-boundary'), status: 'BLOCKED', code: 'CONTEXT_LIMIT', review };
  const turns = [], recoveries = [], mutations = [];
  let releaseSettled, pollEntered, failedPoll = false;
  const heldPoll = new Promise(resolve => { pollEntered = resolve; });
  page.on('request', request => { if (request.method() === 'POST' && /\/(approve|activate)$/.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/authoring') return reply(route, { availability: available, current, conversations: [summary(current), summary(archived)], next: null });
    if (url.pathname.endsWith('/archived-context-boundary')) return reply(route, archived);
    if (url.pathname.endsWith('/turn')) {
      const body = request.postDataJSON(); turns.push(body);
      current = { ...current, version: 2, status: 'RUNNING', code: null,
        operation: { id: body.operationId, version: 2, runId: 'continued-context-run' }, runId: 'continued-context-run' };
      if (approved) return route.abort('failed');
      return reply(route, { operation: current.operation, conversation: current }, 202);
    }
    if (url.pathname.endsWith('/recover')) {
      recoveries.push(request.postDataJSON());
      const originalOperation = current.operation;
      pollEntered(); await new Promise(resolve => { releaseSettled = resolve; });
      current = { ...current, version: 3, status: 'REVIEW_AVAILABLE', code: 'CONTEXT_LIMIT',
        operation: { id: 'later-settled-operation', version: 3, runId: 'later-settled-run' }, runId: 'later-settled-run',
        messages: [message('settled-later', 'A later turn settled in the same discussion.')] };
      return reply(route, { operation: originalOperation, conversation: current });
    }
    if (current.status === 'RUNNING') {
      if (!failedPoll) { failedPoll = true; return reply(route, { message: 'Status temporarily unavailable' }, 503); }
      pollEntered(); await new Promise(resolve => { releaseSettled = resolve; });
      current = { ...current, status: 'REVIEW_AVAILABLE', code: 'CONTEXT_LIMIT', messages: [message('settled', 'The explicit continuation settled.')] };
    }
    return reply(route, current);
  });
  try {
    await openItem(page, extensionId);
    const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
    const recovery = ui.getByRole('article', { name: 'Continue saved work', exact: true });
    await expect(recovery).toHaveCount(1);
    await expect(recovery.getByRole('button', { name: 'Continue here from saved work', exact: true })).toBeEnabled();
    await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    await expect(ui.getByRole('button', { name: 'Continue current changes in a new conversation', exact: true })).toHaveCount(0);
    await composer.fill('Keep this independent unsent correction');
    expect(turns).toEqual([]);
    // Saved approval remains intact; this unfinished discussion offers only explicit continuation.
    if (approved) await page.screenshot({ path: testInfo.outputPath('context-limit-recovery-approved-proof.png'), fullPage: true });
    await recovery.getByRole('button', { name: 'Continue here from saved work', exact: true }).click();
    if (!approved) {
      await expect(ui.getByRole('alert')).toContainText('Authoring progress could not be checked.');
      await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
      await ui.getByRole('button', { name: 'Check authoring status', exact: true }).click();
    }
    await heldPoll;
    await expect(recovery).toHaveCount(1);
    await expect(recovery.getByRole('button', { name: 'Continue here from saved work', exact: true })).toBeDisabled();
    await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    expect(turns).toEqual([{ target: { kind: 'resume', extensionId }, intent: 'discuss', conversationId: 'context-boundary', operationId: expect.any(String),
      text: 'Continue from saved work. Ask before changing any independent examples.', expectedVersion: 1, expectedDraftVersion: before.draftVersion }]);
    releaseSettled();
    await expect(recovery).toHaveCount(0);
    await openSavedChanges(page);
    const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision).toBeVisible();
    await expect(recovery).toHaveCount(0);
    await expect(decision.getByRole('button', { name: approved ? 'Turn on for tasks completed' : 'Approve this change', exact: true })).toBeEnabled();
    if (approved) await page.screenshot({ path: testInfo.outputPath('context-limit-settled-decision.png'), fullPage: true });
    await expect(composer).toHaveValue('Keep this independent unsent correction');
    expect(recoveries).toEqual(approved ? [turns[0]] : []);
    expect(turns).toHaveLength(1);
    expect(await api(page, demo.origin, `extensions/${extensionId}`)).toEqual(before);
    expect(mutations).toEqual([]);
    expect(demo.requests).toEqual([]);
    await page.goto(`${demo.origin}/#customization=${extensionId}&conversation=archived-context-boundary`);
    await expect(recovery).toHaveCount(0);
    await expect(decision).toHaveCount(0);
    await expect(ui.getByText('Earlier discussion · read-only. These messages and examples cannot change or approve your current proposal.', { exact: true })).toBeVisible();
  } finally { releaseSettled?.(); }
});

test('reloading an accepted context continuation keeps the prior decision hidden until settlement', async ({ page, demo }, testInfo) => {
  await signIn(page, demo.origin);
  const admitted = demo.admit('maya', 'Retained approved proposal');
  let saved = await api(page, demo.origin, `extensions/${admitted.extensionId}/compile`, { hookId: TASK_HOOK, source: demo.metadata.source, draftVersion: 0 });
  const extensionId = saved.extension.id;
  saved = await api(page, demo.origin, `extensions/${extensionId}/scenarios`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases: demo.metadata.cases });
  saved = await api(page, demo.origin, `extensions/${extensionId}/simulate`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
  saved = await api(page, demo.origin, `extensions/${extensionId}/approve`, { revisionId: saved.draft.id, draftVersion: saved.draftVersion, evidenceId: saved.evidence.id });
  const before = await api(page, demo.origin, `extensions/${extensionId}`);
  const review = { revisionId: saved.draft.id, draftVersion: saved.draftVersion, suiteDigest: saved.draft.suiteDigest, evidenceId: saved.evidence.id, eligible: true };
  let current = { ...discussion(saved, 'reload-context-continuation'), status: 'BLOCKED', code: 'CONTEXT_LIMIT', review };
  const turns = [], mutations = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/(approve|activate)$/.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
  await page.route('**/api/authoring**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/authoring') return reply(route, { availability: available, current, conversations: [summary(current)], next: null });
    if (path.endsWith('/turn')) {
      const input = request.postDataJSON(); turns.push(input);
      current = { ...current, version: 2, status: 'RUNNING', code: null, review: null, runId: 'accepted-context-run',
        operation: { id: input.operationId, version: 2, runId: 'accepted-context-run' } };
      return reply(route, { operation: current.operation, conversation: current }, 202);
    }
    return reply(route, current);
  });
  await openItem(page, extensionId);
  const ui = studio(page);
  await ui.getByRole('article', { name: 'Continue saved work', exact: true }).getByRole('button', { name: 'Continue here from saved work', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ target: { kind: 'resume', extensionId }, conversationId: 'reload-context-continuation', expectedVersion: 1 });
  expect(new URL(page.url()).hash).toBe('#customization=' + extensionId);
  await page.reload();
  await expect(ui.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(ui.locator('.rs-working')).toContainText('Working on your request');
  await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
  await expect(ui.getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toHaveCount(0);
  await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
  await expect(ui.getByLabel('Customization status', { exact: true }).getByText('Approved · Not on yet', { exact: true })).toBeVisible();
  // Compiled UI with a synthetic accepted run; reload reads status without repeating the paid request.
  await page.screenshot({ path: testInfo.outputPath('context-continuation-running-after-reload.png'), fullPage: true });
  expect(turns).toHaveLength(1);
  current = { ...current, status: 'REVIEW_AVAILABLE', review, messages: [message('settled-reloaded', 'The accepted continuation settled.')] };
  await expect(ui.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await openSavedChanges(page);
  const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
  await expect(decision.getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toBeEnabled();
  await expect(ui.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(turns).toHaveLength(1);
  expect(mutations).toEqual([]);
  expect(await api(page, demo.origin, `extensions/${extensionId}`)).toEqual(before);
  expect(demo.requests).toEqual([]);
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
  const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
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
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Original create request');
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
