import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const activeView = page => studio(page).getByRole('article', { name: 'Version in use', exact: true });
async function api(page, path, body) {
  const session = await (await page.request.get(new URL('/api/session', page.url()).href)).json();
  const response = await page.request.fetch(new URL('/api/' + path, page.url()).href, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: new URL(page.url()).origin, 'X-Session-Context': session.contextToken }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(page, fixture, activeNeedsAttention = false) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const attentionSource = fixture.metadata.source.replace('"PENDING"', '"NEEDS_ATTENTION"');
  const attentionCases = fixture.metadata.cases.map(text => text.replaceAll('"PENDING"', '"NEEDS_ATTENTION"'));
  let state = await api(page, 'extensions', { operationId: crypto.randomUUID(), source: activeNeedsAttention ? attentionSource : fixture.metadata.source, label: 'Active inspection' });
  const path = 'extensions/' + state.extension.id;
  const input = () => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await api(page, path + '/scenarios', { ...input(), cases: activeNeedsAttention ? attentionCases : fixture.metadata.cases });
  state = await api(page, path + '/simulate', input());
  state = await api(page, path + '/approve', { ...input(), evidenceId: state.evidence.id });
  state = await api(page, path + '/activate', { ...input(), generation: state.selection.generation });
  const active = state.selection;
  const source = activeNeedsAttention ? fixture.metadata.source : attentionSource;
  expect(source).not.toBe(activeNeedsAttention ? attentionSource : fixture.metadata.source);
  state = await api(page, path + '/compile', { source, label: 'New checked idea', draftVersion: state.draftVersion });
  const cases = activeNeedsAttention ? fixture.metadata.cases : attentionCases;
  state = await api(page, path + '/scenarios', { ...input(), cases });
  state = await api(page, path + '/simulate', input());
  state = await api(page, path + '/approve', { ...input(), evidenceId: state.evidence.id });
  const draftProof = state.approvedEvidenceId;
  state = await api(page, path + '/simulate', input());
  expect(state.evidence.id).not.toBe(draftProof);
  expect(state.selection.approvedEvidenceId).toBe(active.approvedEvidenceId);
  await page.goto(`${fixture.origin}/#customization=${state.extension.id}`);
  await page.reload();
  await expect(studio(page).getByRole('heading', { name: 'Active inspection', exact: true })).toBeVisible();
  return { path, active, state, draftProof };
}
async function openActive(page) {
  await studio(page).getByRole('button', { name: 'View what’s in use', exact: true }).click();
}

test('active behavior uses its approved proof and a failed reread cannot show cached draft or active results', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, active, state, draftProof } = await seed(page, fixture, true);
    const reads = [], mutations = [];
    page.on('request', request => { if (new URL(request.url()).pathname.includes('/evidence/')) reads.push(new URL(request.url()).pathname.split('/').at(-1)); });
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/extensions')) mutations.push(request.url()); });
    await openActive(page);
    await expect(activeView(page)).toContainText('In the last checked examples');
    await expect(activeView(page)).toContainText('unfinished tasks showed Needs attention');
    await expect(activeView(page)).toContainText('completed tasks showed Done');
    await expect(activeView(page)).not.toContainText('showed Pending');
    expect(reads.at(-1)).toBe(active.approvedEvidenceId);
    expect(await api(page, path)).toEqual(state);
    await activeView(page).getByRole('button', { name: 'Continue saved changes', exact: true }).click();
    await openSavedChanges(page);
    const decision = studio(page).getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision.getByRole('heading', { name: 'Your saved changes', exact: true })).toBeVisible();
    await expect(decision.getByRole('article', { name: 'Example: Unfinished task', exact: true }).locator('dd')).toHaveText(['Pending', 'Pending']);
    expect(reads.at(-1)).toBe(draftProof);
    expect(await api(page, path)).toEqual(state);
    await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await page.route(`**/api/${path}/evidence/${active.approvedEvidenceId}`, route => route.fulfill({ status: 503, json: { message: 'Saved check unavailable' } }), { times: 1 });
    await openActive(page);
    await expect(activeView(page)).not.toContainText('In the last checked examples');
    await expect(activeView(page)).toContainText(/could not|unavailable|not be confirmed/i);
    expect((await api(page, path)).selection).toEqual(active);
    expect(mutations).toEqual([]);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

for (const change of ['owner', 'selection']) test(`a late active proof cannot survive a changed ${change}`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let release;
  try {
    const { path, active, state } = await seed(page, fixture);
    let started;
    const seen = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let finished;
    const settled = new Promise(resolve => { finished = resolve; });
    await page.route(`**/api/${path}/evidence/${active.approvedEvidenceId}`, async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      expect((await response.json()).revisionId).toBe(active.revision.id);
      started(); await held;
      try { await route.fulfill({ response }); } catch { /* A changed owner cancels the old view. */ }
      finished();
    }, { times: 1 });
    await openActive(page); await seen;
    if (change === 'owner') {
      await page.getByLabel('Demo person', { exact: true }).selectOption('sam');
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('sam');
    } else {
      await api(page, path + '/activate', { revisionId: state.draft.id, draftVersion: state.draftVersion, generation: active.generation });
    }
    release(); await settled;
    await expect(activeView(page).getByText(/In the last checked examples/)).toHaveCount(0);
    if (change === 'owner') {
      await expect(page.getByRole('heading', { name: 'Active inspection', exact: true })).toHaveCount(0);
      await expect(page.getByText('unfinished tasks showed Pending', { exact: false })).toHaveCount(0);
    } else {
      await expect(activeView(page).getByRole('status')).toContainText(/changed/i);
      await openActive(page);
      await expect(activeView(page)).toContainText('unfinished tasks showed Needs attention');
      expect((await api(page, path)).selection.revision.id).toBe(state.draft.id);
    }
    expect(fixture.requests).toHaveLength(0);
  } finally { release?.(); await fixture.close(); }
});

test('operator selection has an honest summary fallback without invented approval evidence', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const saved = await api(page, 'extensions');
    expect(saved.selection.approvedEvidenceId).toBeNull();
    await page.goto(`${fixture.origin}/#customization=${saved.selection.revision.extensionId}`);
    await page.reload();
    await openActive(page);
    await expect(activeView(page)).not.toContainText('In the last checked examples');
    await expect(activeView(page)).toContainText(/operator|no saved|no verified/i);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
