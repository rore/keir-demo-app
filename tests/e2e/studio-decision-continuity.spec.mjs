import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const review = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
const composer = page => studio(page).getByLabel('Message to Daymark assistant', { exact: true });
const activate = page => review(page).getByRole('button', { name: /^(Turn on for my tasks|Switch to this customization)$/ });
async function api(page, path, body) {
  const origin = new URL(page.url()).origin;
  const session = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request.fetch(origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'X-Session-Context': session.contextToken }, ...(body === undefined ? {} : { data: body }) });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const input = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
async function seed(page, fixture, { approved = false, native = false, selectionBaseline = false } = {}) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  if (native) {
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved task title');
    await page.locator('#open-customizations').click();
  }
  async function checkedDraft(source, cases, name) {
    const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name });
    const path = 'extensions/' + extensionId;
    let state = await api(page, path + '/compile', { hookId: TASK_HOOK, source, label: name, draftVersion: 0 });
    state = await api(page, path + '/scenarios', { ...input(state), cases });
    return api(page, path + '/simulate', input(state));
  }
  if (selectionBaseline) {
    const existing = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId, title: 'Existing customer follow-up' });
    let active = await checkedDraft(existing.source, existing.cases, 'Existing customer change');
    const path = 'extensions/' + active.extension.id;
    active = await api(page, path + '/approve', { ...input(active), evidenceId: active.evidence.id });
    await api(page, path + '/activate', { ...input(active), generation: active.selection.generation, evidenceId: active.approvedEvidenceId });
  }
  let state = await checkedDraft(fixture.metadata.source, fixture.metadata.cases, 'Continuity proposal');
  const path = 'extensions/' + state.extension.id;
  if (approved) state = await api(page, path + '/approve', { ...input(state), evidenceId: state.evidence.id });
  return { path, state };
}
async function openItem(page, id) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator(`[id="edit-${id}"]`).click();
  await expect(studio(page)).toBeVisible();
  await expect(composer(page)).toBeVisible();
}
async function openReview(page) {
  await studio(page).getByRole('button', { name: 'View saved changes', exact: true }).click();
  await expect(review(page).getByRole('heading', { name: 'Simulation', exact: true })).toBeVisible();
}
async function closeReview(page) {
  await review(page).getByRole('button', { name: 'Hide simulation', exact: true }).click();
  await expect(review(page)).toBeHidden();
}
async function expectIllustration(page, title) {
  const saved = studio(page).getByRole('article', { name: 'About this rule', exact: true });
  await expect(saved).toContainText('About this rule');
  await expect(saved).toContainText(`can request a follow-up titled “${title}”`);
}
async function holdResponse(page, url, { fail = false } = {}) {
  let entered, release, delivered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const finished = new Promise(resolve => { delivered = resolve; });
  await page.route(url, async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    entered();
    await held;
    try {
      await route.fulfill(fail ? { status: 503, json: { message: 'Old read unavailable' } } : { response });
    } catch (error) { if (!route.request().failure()) throw error; }
    finally { delivered(); }
  }, { times: 1 });
  return { started, release, finished };
}
function decisionRequests(page) {
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/extensions\/[^/]+\/(approve|activate)$/.test(new URL(request.url()).pathname))
      requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  return requests;
}
// Only assistant receipts are scripted; draft changes, checks and decisions use the real isolated service.
async function scriptTurns(page, mutate) {
  let current = null;
  const turns = [];
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/authoring' && request.method() === 'GET') return route.fulfill({ json: {
      availability: { available: true, code: null, provider: 'openai', model: 'synthetic-continuity' },
      current, conversations: [], next: null,
    } });
    if (url.pathname === '/api/authoring/turn' && request.method() === 'POST') {
      const body = request.postDataJSON(); turns.push(body);
      const state = await mutate(body), version = body.expectedVersion + 1, runId = 'continuity-run-' + version;
      current = { id: body.conversationId ?? 'continuity-conversation', extensionId: state.extension.id, purpose: 'REVISE', version,
        status: 'AWAITING_USER', runId, operation: { id: body.operationId, version, runId }, code: null, review: null,
        messages: [...(current?.messages ?? []), { id: 'user-' + version, role: 'user', text: body.text, kind: 'text' },
          { id: 'answer-' + version, role: 'assistant', text: 'Continued discussion ' + version, kind: 'text' }], messagesBefore: null,
        draft: { ...input(state), suiteDigest: state.draft.suiteDigest },
        selection: { revisionId: state.selection.revision?.id ?? null, generation: state.selection.generation } };
      return route.fulfill({ status: 202, json: { operation: current.operation, conversation: current } });
    }
    if (url.pathname === '/api/authoring/conversations/' + current?.id) return route.fulfill({ json: current });
    return route.fulfill({ status: 404, json: { message: 'Unexpected synthetic authoring request' } });
  });
  return turns;
}

test('saved review stays readable before its reachable actions at short, phone and desktop sizes', async ({ page }, testInfo) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, state } = await seed(page, fixture);
    const decisions = decisionRequests(page);
    await openItem(page, state.extension.id);
    for (const viewport of [{ width: 683, height: 384 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(viewport);
      await openReview(page);
      const action = review(page).getByRole('button', { name: 'Approve this change', exact: true });
      await expect(action).toBeEnabled();
      const summary = review(page).getByRole('heading', { name: 'Simulation', exact: true });
      await summary.scrollIntoViewIfNeeded();
      await expect(summary).toBeInViewport({ ratio: 0.99 });
      const summaryBox = await summary.boundingBox(), actionBox = await action.boundingBox();
      expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(actionBox.y);
      expect(await summary.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`review-summary-${viewport.width}x${viewport.height}.png`) });
      await action.evaluate(button => button.scrollIntoView({ block: 'center' }));
      await expect(action).toBeInViewport({ ratio: 0.99 });
      expect(await action.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`review-actions-${viewport.width}x${viewport.height}.png`) });
      await closeReview(page);
    }
    expect(decisions).toEqual([]);
    expect(await api(page, path)).toEqual(state);
    expect(fixture.requests).toEqual([]);
  } finally { await fixture.close(); }
});

for (const resource of ['proof', 'source']) test(`closing and reopening explicit review fences a late ${resource} failure`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let hold;
  try {
    const { path, state } = await seed(page, fixture);
    const session = await api(page, 'session');
    expect(session.user.id).toBe(state.owner.id);
    const decisions = decisionRequests(page), reads = [];
    const illustrationRead = { path: `/api/${path}/revisions/${state.draft.id}`, method: 'GET', ownerScoped: true };
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.includes('/evidence/') || pathname.includes('/revisions/')) {
        reads.push({ path: pathname, method: request.method(), ownerScoped: request.headers()['x-session-context'] === session.contextToken });
      }
    });
    await openItem(page, state.extension.id);
    await expectIllustration(page, fixture.metadata.title);
    await expect(review(page)).toHaveCount(0);
    expect(reads).toEqual([illustrationRead]);
    await composer(page).fill('Keep my unsent discussion');
    hold = await holdResponse(page, `**/api/${path}/${resource === 'proof' ? 'evidence/' + state.evidence.id : 'revisions/' + state.draft.id}`, { fail: true });
    await openReview(page); await hold.started;
    await closeReview(page);
    await expect(composer(page)).toHaveValue('Keep my unsent discussion');
    await openReview(page);
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    hold.release(); await hold.finished;
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await expect(review(page)).not.toContainText('could not be confirmed');
    await review(page).getByText('Exact saved change and checks', { exact: true }).click();
    await expect(review(page).getByLabel('Saved source for approval', { exact: true })).toHaveText(fixture.metadata.source);
    await closeReview(page);
    await expect(composer(page)).toHaveValue('Keep my unsent discussion');
    const explicitReadCount = reads.length;
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expectIllustration(page, fixture.metadata.title);
    await expect(review(page)).toHaveCount(0);
    expect(reads.slice(explicitReadCount)).toEqual([illustrationRead]);
    expect(await api(page, path)).toEqual(state);
    expect(decisions).toEqual([]);
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

for (const resource of ['proof', 'source']) test(`reading inside an explicit review does not invalidate its valid ${resource} load`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let hold;
  try {
    const { path, state } = await seed(page, fixture);
    await openItem(page, state.extension.id);
    await expectIllustration(page, fixture.metadata.title);
    hold = await holdResponse(page, `**/api/${path}/${resource === 'proof' ? 'evidence/' + state.evidence.id : 'revisions/' + state.draft.id}`);
    await openReview(page); await hold.started;
    await review(page).getByRole('heading', { name: 'Simulation', exact: true }).click();
    await studio(page).getByRole('log').dispatchEvent('wheel', { deltaY: 80 });
    await page.keyboard.press('PageDown');
    hold.release(); await hold.finished;
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await expect(review(page)).not.toContainText('could not be confirmed');
    expect(await api(page, path)).toEqual(state);
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

for (const operation of ['approve', 'activate']) test(`a late real ${operation} response keeps closed review, composer focus and unsent text`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let hold;
  try {
    const { path, state } = await seed(page, fixture, { approved: operation === 'activate', native: true });
    const turns = await scriptTurns(page, () => api(page, path)), decisions = decisionRequests(page);
    await openItem(page, state.extension.id);
    await openReview(page);
    await expect(operation === 'approve' ? review(page).getByRole('button', { name: 'Approve this change', exact: true }) : activate(page)).toBeEnabled();
    hold = await holdResponse(page, `**/api/${path}/${operation}`);
    await (operation === 'approve' ? review(page).getByRole('button', { name: 'Approve this change', exact: true }) : activate(page)).click();
    await hold.started;
    const committed = await api(page, path);
    expect(committed.approvedEvidenceId).toBe(state.evidence.id);
    expect(committed.selection.generation).toBe(state.selection.generation + (operation === 'activate' ? 1 : 0));
    await closeReview(page);
    await composer(page).fill('My next explicit request');
    await expect(composer(page)).toBeFocused();
    hold.release(); await hold.finished;
    await expect(studio(page).getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('My next explicit request');
    await expect(review(page)).toBeHidden();
    expect(decisions).toEqual([{ path: '/api/' + path + '/' + operation, body: operation === 'approve'
      ? { ...input(state), evidenceId: state.evidence.id } : { ...input(state), generation: state.selection.generation, evidenceId: state.evidence.id } }]);
    if (operation === 'activate') {
      await composer(page).press('Enter');
      await expect(studio(page).getByText('Continued discussion 1', { exact: true })).toBeVisible();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ text: 'My next explicit request', target: { kind: 'revise', extensionId: state.extension.id,
        baseRevisionId: state.draft.id, selectionGeneration: committed.selection.generation } });
      await expect(composer(page)).toHaveValue('');
      await expect(composer(page)).toBeVisible();
      await expect(review(page)).toBeHidden();
      expect(await api(page, path)).toEqual(committed);
      await studio(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved task title');
    }
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

for (const change of ['draft', 'run', 'selection']) test(`a new ${change} preserves the viewed snapshot and disables its older actions`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, state } = await seed(page, fixture, { selectionBaseline: change === 'selection' });
    let latest;
    const turns = await scriptTurns(page, async () => {
      if (change === 'draft') {
        latest = await api(page, path + '/compile', { hookId: TASK_HOOK, source: fixture.metadata.source + '\n', label: 'Later saved draft', draftVersion: state.draftVersion });
        latest = await api(page, path + '/scenarios', { ...input(latest), cases: fixture.metadata.cases });
        latest = await api(page, path + '/simulate', input(latest));
      } else if (change === 'run') latest = await api(page, path + '/simulate', input(state));
      else {
        const active = await api(page, 'extensions/' + state.selection.revision.extensionId);
        latest = await api(page, 'extensions/' + active.extension.id + '/rollback', {
          revisionId: state.selection.revision.id, generation: state.selection.generation,
        });
        latest = await api(page, path);
      }
      return latest;
    });
    const decisions = decisionRequests(page);
    await openItem(page, state.extension.id);
    await openReview(page);
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    if (!await review(page).getByLabel('Saved source for approval', { exact: true }).isVisible())
      await review(page).getByText('Exact saved change and checks', { exact: true }).click();
    await expect(review(page)).toContainText('Evidence: ' + state.evidence.id);
    await composer(page).fill('Please continue checking my request');
    await composer(page).press('Enter');
    await expect(studio(page).getByText('Continued discussion 1', { exact: true })).toBeVisible();
    expect(turns).toHaveLength(1);
    if (change === 'draft') expect(latest.draft.id).not.toBe(state.draft.id);
    if (change === 'run') expect(latest.evidence.id).not.toBe(state.evidence.id);
    if (change === 'selection') expect(latest.selection.generation).toBe(state.selection.generation + 1);
    await expect(review(page)).toBeVisible();
    await expect(review(page)).toContainText('Evidence: ' + state.evidence.id);
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true }).and(review(page).locator('button:enabled'))).toHaveCount(0);
    await expect(studio(page).getByRole('button', { name: 'View latest changes', exact: true })).toBeEnabled();
    await studio(page).getByRole('button', { name: 'View latest changes', exact: true }).click();
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    if (!await review(page).getByLabel('Saved source for approval', { exact: true }).isVisible())
      await review(page).getByText('Exact saved change and checks', { exact: true }).click();
    await expect(review(page)).toContainText('Evidence: ' + latest.evidence.id);
    expect(decisions).toEqual([]);
    expect((await api(page, path)).approved).toBe(false);
    expect(fixture.requests).toEqual([]);
  } finally { await fixture.close(); }
});

test('an earlier run stays read-only when it becomes the approved decision until explicit review entry', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, state: first } = await seed(page, fixture);
    const second = await api(page, path + '/simulate', input(first));
    expect(second.evidence.id).not.toBe(first.evidence.id);
    const decisions = decisionRequests(page);
    await scriptTurns(page, () => api(page, path));
    await openItem(page, first.extension.id);
    await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
    await studio(page).getByText('Open a saved sample run by ID', { exact: true }).click();
    await studio(page).getByLabel('Evidence ID for this person', { exact: true }).fill(first.evidence.id);
    await studio(page).getByRole('button', { name: 'Open saved sample run', exact: true }).click();
    const results = studio(page).getByRole('article', { name: 'Sample results', exact: true });
    await expect(results).toBeVisible();
    await expect(results.locator('.rs-example')).toContainText(fixture.metadata.title);
    await results.locator('.rs-example-details > summary').click();
    await expect(results).toContainText('Evidence: ' + first.evidence.id);
    await expect(review(page)).toBeHidden();
    const approved = await api(page, path + '/approve', { ...input(first), evidenceId: first.evidence.id });
    expect(approved.approvedEvidenceId).toBe(first.evidence.id);
    expect(approved.evidence.id).toBe(second.evidence.id);
    await composer(page).fill('Keep discussing this saved example');
    await composer(page).press('Enter');
    await expect(studio(page).getByText('Continued discussion 1', { exact: true })).toBeVisible();
    await expect(results).toBeVisible();
    await expect(results).toContainText('Evidence: ' + first.evidence.id);
    await expect(review(page)).toBeHidden();
    await expect(results.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    await expect(results.getByRole('button', { name: /^(Turn on for my tasks|Switch to this customization)$/ })).toHaveCount(0);
    await openReview(page);
    await expect(activate(page)).toBeEnabled();
    await review(page).getByText('Exact saved change and checks', { exact: true }).click();
    await expect(review(page)).toContainText('Evidence: ' + first.evidence.id);
    expect(decisions).toEqual([]);
    expect(await api(page, path)).toEqual(approved);
    expect(fixture.requests).toEqual([]);
  } finally { await fixture.close(); }
});
