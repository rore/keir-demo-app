import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

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
const saved = (page, id) => { expect(id).toBeTruthy(); return api(page, extPath(id)); };
const source = (page, id, revisionId) => api(page, `${extPath(id)}/revisions/${encodeURIComponent(revisionId)}`);
async function navigate(page, destination) {
  const main = page.getByRole('navigation', { name: 'Main navigation' });
  const mobile = page.getByRole('combobox', { name: 'Destination', exact: true });
  await expect.poll(async () => await main.isVisible().catch(() => false) || await mobile.isVisible().catch(() => false)).toBe(true);
  if (await main.isVisible().catch(() => false)) await main.getByRole('button', { name: destination, exact: true }).click();
  else await mobile.selectOption(destination.toLowerCase());
}
async function enterTaskStudio(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved native title');
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page)).toBeVisible();
  await navigate(page, 'Customizations');
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(studio(page)).toBeVisible();
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
async function createCandidate(page, fixture, { label = 'Independent saved proposal', sourceText = fixture.metadata.source,
      cases = fixture.metadata.cases, simulate = true } = {}) {
  let state = await api(page, 'extensions', { operationId: crypto.randomUUID(), source: sourceText, label });
  const id = state.extension.id;
  if (cases) state = await api(page, `${extPath(id)}/scenarios`, { revisionId: state.draft.id, cases, draftVersion: state.draftVersion });
  if (simulate) state = await api(page, `${extPath(id)}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
  return { id, state };
}
function createItems(items) { return items.filter(item => item.extension?.creationOperationId); }

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`agent-led scripted example uses real checks and separate human decisions ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      await enterTaskStudio(page, fixture.origin);
      const ui = studio(page);
      const before = await collection(page);
      const scripted = await api(page, 'authoring/example');
      const activeId = before.selection.revision.extensionId;
      const activeBefore = await saved(page, activeId);
      await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Try on sample tasks', exact: true })).toHaveCount(0);
      const composer = ui.getByLabel('Message to Studio');
      await composer.fill('Keep this unsent personal request');
      await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
      await expect(ui.getByRole('article', { name: 'Scripted example', exact: true })).toContainText('Scripted example · no AI.');
      expect(await collection(page)).toEqual(before);
      await expect(composer).toHaveValue('Keep this unsent personal request');
      await expect(ui.locator('.rs-composer')).toBeHidden();
      await ui.getByRole('button', { name: 'Return to my request', exact: true }).click();
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue('Keep this unsent personal request');
      await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
      await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
      if (viewport.width === 1440) await page.route('**/api/extensions/*/evidence/*', async route => {
        const response = await route.fetch(), proof = await response.json();
        delete proof.reports[0].report.consumption;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(proof) });
      }, { times: 2 });
      await ui.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
      const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
      await expect(decision).toBeVisible();
      if (viewport.width === 1440) {
        await expect(decision).toContainText('The exact saved change and its examples could not be confirmed');
        await expect(decision.getByRole('button', { name: 'Check saved change again', exact: true })).toBeVisible();
        await decision.getByRole('button', { name: 'Check saved change again', exact: true }).click();
      }
      await expect(decision).toContainText('In the checked examples, unfinished tasks showed Needs attention; completed tasks showed Done. This changes only your advice.');
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeVisible();
      const after = await collection(page), created = createItems(after.items);
      expect(created).toHaveLength(1);
      const newId = created[0].extension.id;
      expect(newId).not.toBe(activeId);
      const prepared = await saved(page, newId), documents = await source(page, newId, prepared.draft.id);
      expect(prepared.draft.kind).toBe('authored');
      expect(prepared.evidence.passed).toBe(true);
      expect(prepared.approved).toBe(false);
      expect(prepared.selection).toEqual(before.selection);
      expect(prepared.extension.id).toBe(newId);
      expect(documents.source).toBe(scripted.source);
      expect(documents.cases).toEqual(scripted.cases);
      expect(await saved(page, activeId)).toEqual(activeBefore);
      expect(fixture.requests).toHaveLength(0);
      mkdirSync('build/studio-extension-creation', { recursive: true });
      await page.screenshot({ path: `build/studio-extension-creation/agent-led-checked-${viewport.width}x${viewport.height}.png` });

      const exampleLink = decision.getByRole('button', { name: 'Show the unfinished task example', exact: true });
      await expect(exampleLink).toBeVisible();
      await exampleLink.click();
      await expect(ui.locator('.rs-example')).toHaveCount(1);
      await expect(ui.getByRole('heading', { name: 'What an unfinished task would show', exact: true })).toBeVisible();
      await expect(ui.locator('.rs-example').first()).toContainText('Needs attention');
      await expect(ui.locator('.rs-preview')).toContainText('Example only — your tasks were not changed.');
      await ui.getByText('Other checked examples', { exact: true }).click();
      await ui.getByRole('button', { name: 'What a completed task would show', exact: true }).click();
      await expect(ui.locator('.rs-example')).toHaveCount(1);
      await expect(ui.getByRole('heading', { name: 'What a completed task would show', exact: true })).toBeVisible();
      await expect(ui.locator('.rs-example').first()).toContainText('Done');
      await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(exampleLink).toBeFocused();
      await ui.getByText('Exact saved change and checks', { exact: true }).click();
      await expect(decision.getByLabel('Saved source for approval', { exact: true })).toHaveText(documents.source);
      expect(documents.cases).toHaveLength(5);
      for (let index = 0; index < documents.cases.length; index++)
        await expect(decision.getByLabel(`Saved example ${index + 1} for approval`, { exact: true })).toHaveText(documents.cases[index]);
      expect(await saved(page, newId)).toEqual(prepared);
      await decision.getByRole('button', { name: 'Approve this change', exact: true }).click();
      const approved = await saved(page, newId);
      expect(approved.approvedEvidenceId).toBe(prepared.evidence.id);
      expect(approved.selection).toEqual(before.selection);
      await expect(decision.getByRole('button', { name: 'Switch to this customization', exact: true })).toBeFocused().catch(() => {});
      const activation = decision.getByRole('button', { name: /^(Turn on for my tasks|Switch to )/ });
      await activation.click();
      await expect.poll(async () => (await saved(page, newId)).selection.revision.id).toBe(prepared.draft.id);
      const completion = ui.getByRole('article', { name: 'Advice is on', exact: true });
      await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeFocused();
      await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeInViewport();
      await expect(completion.getByRole('button', { name: 'Return to customizations', exact: true })).toBeInViewport();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
      await page.screenshot({ path: `build/studio-extension-creation/agent-led-on-${viewport.width}x${viewport.height}.png` });
      await completion.getByRole('button', { name: 'Return to customizations', exact: true }).click();
      await navigate(page, 'Tasks');
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved native title');
      await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
      await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
      await expect(ui.locator('.rs-chat')).toContainText('This customization is on. What would you like to change?');
      await expect(ui.locator('.rs-chat')).not.toContainText('advice advice');
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}

test('an exact review without verified situation metadata keeps generic labels despite the scripted example', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enterCollection(page, fixture.origin);
    const { id, state } = await createCandidate(page, fixture);
    const before = await collection(page);
    expect(state.owner.id).toBe(before.owner.id);
    await page.route(`**/api/extensions/${id}/evidence/${state.evidence.id}`, async route => {
      const response = await route.fetch(), proof = await response.json();
      for (const item of proof.reports) { delete item.taskStatus; delete item.readFailure; delete item.report.consumption; item.label = 'untrusted-case-label'; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(proof) });
    });
    await openItem(page, id);
    const ui = studio(page), decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision).toBeVisible();
    await expect(decision).toContainText('The exact saved change and its examples could not be confirmed');
    await expect(decision.getByRole('button', { name: 'Check saved change again', exact: true })).toBeVisible();
    expect(await saved(page, id)).toEqual(state);
    await ui.getByRole('button', { name: 'History and details', exact: true }).click();
    const tools = ui.locator('.rs-tools');
    await tools.getByText('Saved sample runs', { exact: true }).click();
    await tools.getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    await expect(ui.locator('.rs-example')).toHaveCount(1);
    await expect(ui.locator('.rs-example').first().getByRole('heading', { name: 'Example 1', exact: true })).toBeVisible();
    await expect(ui.locator('.rs-example').first()).not.toContainText('untrusted-case-label');
    await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    expect((await saved(page, id)).approved).toBe(false);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('guided example does not replace an unrelated saved proposal on reentry', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enterCollection(page, fixture.origin);
    const { id, state: before } = await createCandidate(page, fixture, { label: 'Independent pending proposal', cases: null, simulate: false });
    const beforeSource = await source(page, id, before.draft.id);
    await openItem(page, id);
    await expect(studio(page).getByRole('button', { name: 'Try a guided example · no AI', exact: true })).toHaveCount(0);
    expect(await saved(page, id)).toEqual(before);
    expect(await source(page, id, before.draft.id)).toEqual(beforeSource);

    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const newStudio = studio(page);
    await newStudio.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
    await expect(newStudio.getByRole('article', { name: 'Scripted example', exact: true })).toBeVisible();
    await newStudio.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
    await expect(newStudio.getByRole('article', { name: 'Current decision', exact: true })
      .getByRole('heading', { name: 'Ready for your decision', exact: true })).toBeVisible();
    const after = await collection(page), scriptedItems = createItems(after.items).filter(item => item.extension.id !== id
      && item.draft?.label === 'Scripted example: task advice');
    expect(scriptedItems).toHaveLength(1);
    const newId = scriptedItems[0].extension.id;
    expect(newId).not.toBe(id);
    const created = await saved(page, newId), createdSource = await source(page, newId, created.draft.id);
    expect(created.draft.kind).toBe('authored');
    expect(created.evidence.passed).toBe(true);
    expect(created.approved).toBe(false);
    expect(created.selection).toEqual(before.selection);
    const sample = await api(page, 'authoring/example');
    expect(createdSource.source).toBe(sample.source);
    expect(createdSource.cases).toEqual(sample.cases);
    expect(await saved(page, id)).toEqual(before);
    expect(await source(page, id, before.draft.id)).toEqual(beforeSource);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('ordinary examples explain a display-only mismatch and retain its original expectation after a draft edit', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enterCollection(page, fixture.origin);
    const cases = fixture.metadata.cases.map(text => {
      const value = JSON.parse(text);
      if (value.id === 'synthetic-open') value.expect.consumption = { status: 'NOT_DISPLAYED' };
      return JSON.stringify(value, null, 2);
    });
    const { id, state: prepared } = await createCandidate(page, fixture, { label: 'Independent display expectation', cases });
    expect(prepared.evidence.passed).toBe(false);
    const ui = await openItem(page, id);
    await ui.getByRole('button', { name: 'History and details', exact: true }).click();
    const details = ui.locator('.rs-tools');
    await details.getByText('Saved sample runs', { exact: true }).click();
    await details.getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    const first = ui.locator('.rs-example').first();
    await expect(first.locator('dl > div').first()).toHaveText('You wantedNo advice');
    await expect(first.locator('dl > div').nth(1)).toHaveText('In this examplePending');
    await expect(first).toContainText('This example needs a correction');
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    const changedCases = fixture.metadata.cases;
    const edited = await api(page, `${extPath(id)}/compile`, { source: fixture.metadata.source, label: 'A different saved proposal', draftVersion: prepared.draftVersion });
    await api(page, `${extPath(id)}/scenarios`, { revisionId: edited.draft.id, cases: changedCases, draftVersion: edited.draftVersion });
    await ui.getByRole('button', { name: 'History and details', exact: true }).click();
    await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
    await ui.getByText('Open a saved sample run by ID', { exact: true }).click();
    await ui.getByLabel('Evidence ID for this person', { exact: true }).fill(prepared.evidence.id);
    await ui.getByRole('button', { name: 'Open saved sample run', exact: true }).click();
    await expect(first.locator('dl > div').first()).toHaveText('You wantedNo advice');
    await expect(first.locator('dl > div').nth(1)).toHaveText('In this examplePending');
    expect((await saved(page, id)).approved).toBe(false);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
