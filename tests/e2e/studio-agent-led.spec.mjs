import { test, expect } from '@playwright/test';
import { openDeveloperTools, openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }, { path, body });
}
const collection = page => api(page, 'extensions');
const extPath = id => `extensions/${encodeURIComponent(id)}`;
const saved = (page, id) => api(page, extPath(id));
const source = (page, id, revisionId) => api(page, `${extPath(id)}/revisions/${encodeURIComponent(revisionId)}`);
const input = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
async function navigate(page, destination) {
  const main = page.getByRole('navigation', { name: 'Main navigation' });
  const mobile = page.getByLabel('Destination', { exact: true });
  await expect.poll(async () => await main.isVisible().catch(() => false) || await mobile.isVisible().catch(() => false)).toBe(true);
  if (await main.isVisible()) await main.getByRole('button', { name: destination, exact: true }).click();
  else await mobile.selectOption(destination.toLowerCase());
}
async function enterCollection(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await navigate(page, 'Customizations');
}
async function openItem(page, id) {
  await page.reload();
  await navigate(page, 'Customizations');
  await page.locator(`#edit-${id}`).click();
  await expect(studio(page)).toBeVisible();
  return studio(page);
}
// This setup admits no approval or executable selection; the installed compiler and simulator check the bytes.
async function createCandidate(page, fixture, { label = 'Independent saved proposal', sourceText = fixture.metadata.source,
  cases = fixture.metadata.cases, simulate = true } = {}) {
  const { extensionId: id } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: label });
  let state = await api(page, `${extPath(id)}/compile`, { hookId: TASK_HOOK, source: sourceText, label, draftVersion: 0 });
  if (cases) state = await api(page, `${extPath(id)}/scenarios`, { ...input(state), cases });
  if (simulate) state = await api(page, `${extPath(id)}/simulate`, input(state));
  return { id, state };
}
async function send(page, text) {
  await studio(page).getByLabel('Message to Daymark assistant', { exact: true }).fill(text);
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
}
async function authorCandidate(page, fixture) {
  await send(page, `When I complete a task in ${fixture.metadata.projectName}, create ${fixture.metadata.title}. Other projects should create nothing.`);
  await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible();
  await send(page, `Confirmed: use ${fixture.metadata.title} in ${fixture.metadata.projectName}, with the independent examples.`);
  await expect(studio(page).getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 683, height: 384 }]) {
  test(`agent-led task customization uses real checks and separate human decisions ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture();
    try {
      await page.setViewportSize(viewport);
      await enterCollection(page, fixture.origin);
      const baseline = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId, title: 'Existing customer follow-up' });
      const { id: activeId, state: checked } = await createCandidate(page, fixture, { label: 'Existing customer change', sourceText: baseline.source, cases: baseline.cases });
      let activeBefore = await api(page, `${extPath(activeId)}/approve`, { ...input(checked), evidenceId: checked.evidence.id });
      activeBefore = await api(page, `${extPath(activeId)}/activate`, { ...input(activeBefore),
        generation: activeBefore.selection.generation, evidenceId: activeBefore.approvedEvidenceId });
      await navigate(page, 'Tasks');
      await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
      await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved native title');
      await page.locator('#open-customizations').click();
      await navigate(page, 'Customizations');
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      const ui = studio(page), before = await collection(page);
      const nativeBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
      const composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
      await composer.fill('Keep this unsent personal request');
      await expect(ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true })).toHaveCount(0);
      await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
      await ui.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      expect(await collection(page)).toEqual(before);
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      const newId = await authorCandidate(page, fixture);
      expect(newId).not.toBe(activeId);
      await composer.fill('Keep this unsent personal request');
      if (viewport.width === 1440) await page.route('**/api/extensions/*/evidence/*', async route => {
        const response = await route.fetch(), proof = await response.json();
        delete proof.reports[0].report.observed;
        await route.fulfill({ status: 200, json: proof });
      }, { times: 1 });
      await openSavedChanges(page);
      const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
      if (viewport.width === 1440) {
        await expect(decision).toContainText('The exact saved change and its examples could not be confirmed');
        await decision.getByRole('button', { name: 'Check saved results again', exact: true }).click();
      }
      await expect(decision).toContainText(fixture.metadata.title);
      await expect(decision).toContainText('Example tasks; your tasks are unchanged.');
      const prepared = await saved(page, newId), documents = await source(page, newId, prepared.draft.id);
      expect(prepared.draft.kind).toBe('authored'); expect(prepared.evidence.passed).toBe(true); expect(prepared.approved).toBe(false);
      expect(prepared.selection).toEqual(before.selection);
      expect(documents.source).toBe(fixture.metadata.source); expect(documents.cases).toEqual(fixture.metadata.cases);
      expect(await saved(page, activeId)).toEqual(activeBefore);
      expect(fixture.requests.map(item => item.name)).toEqual(['resolve_intent', 'discover_catalog', 'ask_clarification', 'resolve_intent', 'discover_catalog', 'compile_draft', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);
      const proposed = decision.getByRole('region', { name: 'Checked proposed behavior', exact: true });
      await expect(proposed.getByRole('article', { name: /^Example:/ })).toHaveCount(documents.cases.length);
      await expect(proposed).toContainText(fixture.metadata.title);
      await decision.getByRole('button', { name: 'Inspect examples and what’s in use', exact: true }).click();
      const comparison = ui.getByRole('article', { name: 'Sample results', exact: true });
      await expect(comparison.getByRole('region', { name: 'Checked behavior currently in use', exact: true })).toContainText('Existing customer follow-up');
      await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(decision.getByRole('article', { name: /^Example:/ }).first()).toBeVisible();
      await expect(proposed.getByRole('article', { name: /^Example:/ }).nth(1)).toContainText('No change.');
      await ui.getByText('Technical details for this version', { exact: true }).click();
      await expect(decision.getByLabel('Saved source for approval', { exact: true })).toHaveText(documents.source);
      for (let index = 0; index < documents.cases.length; index++)
        await expect(decision.getByLabel(`Saved example ${index + 1} for approval`, { exact: true })).toHaveText(documents.cases[index]);
      mkdirSync('build/studio-extension-creation', { recursive: true });
      await page.screenshot({ path: `build/studio-extension-creation/agent-led-checked-${viewport.width}x${viewport.height}.png` });
      await decision.getByRole('button', { name: 'Approve this change', exact: true }).click();
      const approved = await saved(page, newId);
      expect(approved.approvedEvidenceId).toBe(prepared.evidence.id); expect(approved.selection).toEqual(before.selection);
      await decision.getByRole('button', { name: 'Turn on for tasks completed', exact: true }).click();
      await expect.poll(async () => (await saved(page, newId)).selection.revision.id).toBe(prepared.draft.id);
      expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);
      await expect(ui.locator('#studio-view-active')).toContainText('On: this version');
      await expect(composer).toHaveValue('Keep this unsent personal request');
      await page.screenshot({ path: `build/studio-extension-creation/agent-led-on-${viewport.width}x${viewport.height}.png` });
      await ui.getByRole('button', { name: 'More', exact: true }).click();
      await ui.getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved native title');
      await expect(page.getByRole('button', { name: 'Check task advice', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await page.getByRole('button', { name: 'Complete Gather material references', exact: true }).click();
      const outcome = page.getByRole('region', { name: 'Customization outcome', exact: true });
      await expect(outcome.getByRole('button', { name: `Open task: ${fixture.metadata.title}`, exact: true })).toBeVisible();
      await outcome.getByRole('button', { name: `Open task: ${fixture.metadata.title}`, exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(fixture.metadata.title);
      await page.locator('#open-customizations').click();
      await expect(ui.locator('#studio-view-active')).toContainText('On: this version');
      await expect(ui.locator('.rs-chat')).toContainText(fixture.metadata.offerText);
      await expect(composer).toBeVisible();
      expect(fixture.requests).toHaveLength(10);
    } finally { await fixture.close(); }
  });
}

test('an exact review without verified situation metadata keeps generic labels', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enterCollection(page, fixture.origin);
    const { id, state } = await createCandidate(page, fixture);
    await page.route(`**/api/extensions/${id}/evidence/${state.evidence.id}`, async route => {
      const response = await route.fetch(), proof = await response.json();
      for (const item of proof.reports) { delete item.report.scenario; delete item.report.observed; item.label = 'untrusted-case-label'; }
      proof.summary = null;
      await route.fulfill({ status: 200, json: proof });
    });
    const ui = await openItem(page, id);
    await openSavedChanges(page);
    const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision).toContainText('The exact saved change and its examples could not be confirmed');
    expect(await saved(page, id)).toEqual(state);
    await ui.getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    const tools = ui.locator('.rs-tools');
    await tools.getByText('Saved sample runs', { exact: true }).click();
    await tools.getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    const earlier = ui.getByRole('article', { name: 'Sample results', exact: true });
    await expect(earlier.locator('.rs-example')).toHaveCount(1);
    const example = earlier.locator('.rs-example');
    await expect(example).toHaveAccessibleName(/Earlier saved example 1$/);
    await expect(example.locator('dd').first()).toHaveText('Earlier saved example 1');
    await expect(example).not.toHaveAccessibleName(/untrusted-case-label/);
    await expect(earlier.locator('.rs-example')).not.toContainText('untrusted-case-label');
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    expect((await saved(page, id)).approved).toBe(false); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('a new assistant proposal does not replace an unrelated saved proposal on reentry', async ({ page }) => {
  const fixture = await startAuthoringFixture();
  try {
    await enterCollection(page, fixture.origin);
    const other = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId, title: 'Unrelated saved task' });
    const { id, state: before } = await createCandidate(page, fixture, { label: 'Independent proposal', sourceText: other.source, cases: null, simulate: false });
    const beforeSource = await source(page, id, before.draft.id);
    await openItem(page, id);
    await expect(studio(page).getByRole('button', { name: 'Try a guided example · no AI', exact: true })).toHaveCount(0);
    expect(await saved(page, id)).toEqual(before); expect(await source(page, id, before.draft.id)).toEqual(beforeSource);
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const newId = await authorCandidate(page, fixture);
    await openSavedChanges(page);
    expect(newId).not.toBe(id);
    const created = await saved(page, newId), documents = await source(page, newId, created.draft.id);
    expect(created.draft.kind).toBe('authored'); expect(created.evidence.passed).toBe(true); expect(created.approved).toBe(false);
    expect(created.selection).toEqual(before.selection);
    expect(documents.source).toBe(fixture.metadata.source); expect(documents.cases).toEqual(fixture.metadata.cases);
    expect(await saved(page, id)).toEqual(before); expect(await source(page, id, before.draft.id)).toEqual(beforeSource);
    expect(fixture.requests).toHaveLength(10);
  } finally { await fixture.close(); }
});

test('ordinary examples retain independent task expectations and observed mismatch after a draft edit', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enterCollection(page, fixture.origin);
    const cases = fixture.metadata.cases.map(text => JSON.parse(text));
    const { expect: expected } = cases[0];
    const { trace, effects } = expected.outcome;
    const receipt = trace.find(event => event.event === 'EFFECT_RECORDED');
    const error = { code: 'ACCESS_DENIED', path: '/steps/3' };
    const classification = 'BUSINESS_REJECTION';
    receipt.state = 'NONE';
    effects[0].state = 'NONE';
    expected.outcome = { classification, error, effects, trace: [
      ...trace.slice(0, receipt.sequence + 1), { sequence: receipt.sequence + 1, event: 'TERMINATED', code: error.code },
    ] };
    expected.consumption = { status: 'REPORTED', classification, error, effects };
    const originals = cases.map(value => JSON.stringify(value, null, 2));
    const { id, state: prepared } = await createCandidate(page, fixture, { label: 'Independent task expectation', cases: originals });
    expect(prepared.evidence.passed).toBe(false);
    const proof = await api(page, `${extPath(id)}/evidence/${prepared.evidence.id}`);
    expect(proof.summary.cases[0].verification).toBe('mismatched');
    expect(proof.reports[0].report.mismatches.length).toBeGreaterThan(0);
    expect(proof.reports[0].expected.createdTasks).toEqual([]);
    expect(proof.reports[0].report.observed.createdTasks[0].title).toBe(fixture.metadata.title);
    expect((await source(page, id, prepared.draft.id)).cases).toEqual(originals);
    const ui = await openItem(page, id);
    await ui.getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    const tools = ui.locator('.rs-tools');
    await tools.getByText('Saved sample runs', { exact: true }).click();
    await tools.getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    const first = ui.locator('.rs-example').first();
    await expect(first.locator('dd').nth(1)).toHaveText('No change.');
    await expect(first.locator('dd').nth(2)).toContainText(fixture.metadata.title);
    await expect(first).toContainText('Different from what we wanted');
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    const edited = await api(page, `${extPath(id)}/compile`, { hookId: TASK_HOOK, source: fixture.metadata.source + '\n', label: 'A different saved proposal', draftVersion: prepared.draftVersion });
    await api(page, `${extPath(id)}/scenarios`, { ...input(edited), cases: fixture.metadata.cases });
    await ui.getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
    await ui.getByText('Open a saved sample run by ID', { exact: true }).click();
    await ui.getByLabel('Evidence ID for this person', { exact: true }).fill(prepared.evidence.id);
    await ui.getByRole('button', { name: 'Open saved sample run', exact: true }).click();
    await expect(first.locator('dd').nth(1)).toHaveText('No change.');
    await expect(first.locator('dd').nth(2)).toContainText(fixture.metadata.title);
    const historical = await api(page, `${extPath(id)}/evidence/${prepared.evidence.id}`);
    expect(historical.reports[0].expected.createdTasks).toEqual([]);
    expect(historical.reports).toEqual(proof.reports);
    expect((await saved(page, id)).approved).toBe(false); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
