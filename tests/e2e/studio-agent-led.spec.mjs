import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
async function saved(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await fetch('/api/extensions', { headers: { 'X-Session-Context': session.contextToken } })).json();
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`agent-led scripted example uses real checks and separate human decisions ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
      await page.getByLabel('Task title', { exact: true }).fill('Keep this unsaved native title');
      await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
      const ui = studio(page), initial = await saved(page);
      await expect(ui.getByText(/Advice appears when you choose Check task advice/)).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Try on sample tasks', exact: true })).toHaveCount(0);
      const composer = ui.getByLabel('Message to Studio');
      await composer.fill('Keep this unsent personal request');
      await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
      await expect(ui.getByRole('article', { name: 'Scripted example', exact: true })).toContainText('Scripted example · no AI.');
      expect(await saved(page)).toEqual(initial);
      await expect(composer).toHaveValue('Keep this unsent personal request');
      await expect(ui.locator('.rs-composer')).toBeHidden();
      await ui.getByRole('button', { name: 'Return to my request', exact: true }).click();
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue('Keep this unsent personal request');
      await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
      await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
      await expect(ui.locator('.rs-composer')).toBeHidden();
      await ui.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
      await expect(ui.getByText('The examples match: open tasks show Needs attention, completed tasks show Done, and unavailable tasks show no advice. This is only a proposal; your current advice is unchanged.', { exact: true })).toBeVisible();
      const prepared = await saved(page);
      expect(prepared.draft.kind).toBe('authored');
      expect(prepared.evidence.passed).toBe(true);
      expect(prepared.approved).toBe(false);
      expect(prepared.selection).toEqual(initial.selection);
      expect(fixture.requests).toHaveLength(0);
      mkdirSync('build/screens', { recursive: true });
      await page.screenshot({ path: `build/screens/scripted-checked-${viewport.width}x${viewport.height}.png` });
      const examples = ui.getByRole('button', { name: 'See 5 sample tasks', exact: true });
      if (viewport.width === 1440) await page.route(`**/api/extensions/evidence/${prepared.evidence.id}`, async route => {
        const response = await route.fetch(), proof = await response.json();
        delete proof.reports[0].report.consumption;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(proof) });
      }, { times: 1 });
      await examples.click();
      await expect(ui.locator('.rs-example')).toHaveCount(5);
      if (viewport.width === 1440) {
        await expect(ui.locator('.rs-example').first().getByRole('heading')).toHaveText('Unfinished task');
        await expect(ui.locator('.rs-example').first().locator('dl > div').nth(1)).toHaveText('In this exampleNot observed');
        await expect(ui.getByRole('heading', { name: 'Some results were not observed', exact: true })).toBeVisible();
        await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
        await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
        await page.route(`**/api/extensions/evidence/${prepared.evidence.id}`, async route => {
          const response = await route.fetch(), proof = await response.json();
          delete proof.reports[0].report.consumption;
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(proof) });
        }, { times: 1 });
        await ui.getByRole('button', { name: 'See what will change', exact: true }).click();
        await expect(ui.getByRole('alert').filter({ hasText: 'The saved proposal or its observations could not be confirmed. Approval is unavailable.' })).toBeVisible();
        await expect(ui.getByRole('button', { name: 'This is what I want', exact: true })).toHaveCount(0);
        await examples.click();
      }
      await expect(ui.locator('.rs-example').first()).toContainText('Needs attention');
      await ui.locator('.rs-example').first().scrollIntoViewIfNeeded();
      await expect(ui.locator('.rs-example').first()).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: `build/screens/scripted-examples-${viewport.width}x${viewport.height}.png` });
      await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(examples).toBeFocused();
      await ui.getByRole('button', { name: 'See what will change', exact: true }).click();
      const review = ui.getByRole('article', { name: 'Review exact advice', exact: true });
      await expect(review).toBeVisible();
      await expect(review.locator('li strong')).toHaveText(['Unfinished task', 'Completed task', 'Missing task', 'Task access denied', 'Read temporarily unavailable']);
      mkdirSync('build/scenario-repair', { recursive: true });
      await page.screenshot({ path: `build/scenario-repair/presentation-review-${viewport.width}x${viewport.height}.png` });
      await expect(review.getByLabel('Saved source for approval', { exact: true })).toBeHidden();
      await review.getByText('Exact saved source and examples', { exact: true }).click();
      const documents = await page.evaluate(async revisionId => {
        const session = await (await fetch('/api/session')).json();
        return (await fetch(`/api/extensions/revisions/${revisionId}`, { headers: { 'X-Session-Context': session.contextToken } })).json();
      }, prepared.draft.id);
      await expect(review.getByLabel('Saved source for approval', { exact: true })).toHaveText(documents.source);
      expect(documents.cases).toHaveLength(5);
      expect(await saved(page)).toEqual(prepared);
      await review.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
      await review.getByRole('button', { name: 'This is what I want', exact: true }).click();
      const turnOn = ui.getByRole('button', { name: 'Turn on for my tasks', exact: true });
      await expect(turnOn).toBeFocused();
      const approved = await saved(page);
      expect(approved.approvedEvidenceId).toBe(prepared.evidence.id);
      expect(approved.selection).toEqual(initial.selection);
      await expect(review.getByRole('checkbox')).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'This is what I want', exact: true })).toHaveCount(0);
      await turnOn.click();
      await expect.poll(async () => (await saved(page)).selection.revision.id).toBe(prepared.draft.id);
      const completion = ui.getByRole('article', { name: 'Advice is on', exact: true });
      await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeFocused();
      await expect(completion.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeInViewport();
      await expect(completion.getByRole('button', { name: 'Return to my task', exact: true })).toBeInViewport();
      await expect(ui.getByRole('button', { name: 'This is what I want', exact: true })).toHaveCount(0);
      await page.screenshot({ path: `build/screens/scripted-on-${viewport.width}x${viewport.height}.png` });
      await completion.getByRole('button', { name: 'See approved examples', exact: true }).click();
      await ui.getByRole('button', { name: 'Review this advice', exact: true }).click();
      await expect(review.getByRole('heading', { name: 'On for your tasks', exact: true })).toBeVisible();
      await review.getByText('Reviewed examples and exact details', { exact: true }).click();
      await review.getByText('Exact saved source and examples', { exact: true }).click();
      await expect(review.getByLabel('Saved source for approval', { exact: true })).toHaveText(documents.source);
      await expect(review.getByRole('checkbox')).toHaveCount(0);
      await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unsaved native title');
      await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Task advice: Needs attention' })).toBeVisible();
      await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
      await expect(ui.locator('.rs-chat')).toContainText('Your task advice is on. What would you like to change?');
      await expect(ui.locator('.rs-chat')).not.toContainText('advice advice');
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}

test('an exact review without verified situation metadata keeps generic labels despite the scripted example', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    const ui = studio(page);
    await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
    await ui.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'See what will change', exact: true })).toBeVisible();
    const state = await saved(page);
    await page.route(`**/api/extensions/evidence/${state.evidence.id}`, async route => {
      const response = await route.fetch(), proof = await response.json();
      for (const item of proof.reports) { delete item.taskStatus; delete item.readFailure; item.label = 'untrusted-case-label'; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(proof) });
    });
    await ui.getByRole('button', { name: 'See what will change', exact: true }).click();
    const review = ui.getByRole('article', { name: 'Review exact advice', exact: true });
    await expect(review.locator('li strong')).toHaveText(['Example 1', 'Example 2', 'Example 3', 'Example 4', 'Example 5']);
    await expect(review).not.toContainText('untrusted-case-label');
    await expect(review.getByRole('button', { name: 'This is what I want', exact: true })).toBeDisabled();
    expect((await saved(page)).approved).toBe(false); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('guided example does not replace an unrelated saved proposal on reentry', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const headers = { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken };
      const current = await (await fetch('/api/extensions', { headers })).json();
      const response = await fetch('/api/extensions/draft', { method: 'POST', headers, body: JSON.stringify({ templateId: 'pending', draftVersion: current.draftVersion }) });
      if (!response.ok) throw new Error('Could not prepare independent saved proposal');
    });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const before = await saved(page);
    await studio(page).getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
    await expect(studio(page).getByText('You have a saved proposal. You can continue it here; the guided example will not replace it.', { exact: true })).toBeVisible();
    expect(await saved(page)).toEqual(before);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('ordinary examples explain a display-only mismatch and retain its original expectation after a draft edit', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const prepared = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const headers = { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken };
      const read = async path => (await fetch(`/api/${path}`, { headers })).json();
      const post = async (path, body) => {
        const response = await fetch(`/api/extensions/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Preparation failed: ${path}`);
        return response.json();
      };
      const example = await read('authoring/example'), initial = await read('extensions');
      const cases = example.cases.map(text => {
        const value = JSON.parse(text);
        if (value.id === 'open') value.expect.consumption = { status: 'NOT_DISPLAYED' };
        return JSON.stringify(value);
      });
      let state = await post('compile', { source: example.source, label: 'Independent display expectation', draftVersion: initial.draftVersion });
      state = await post('scenarios', { revisionId: state.draft.id, cases, draftVersion: state.draftVersion });
      state = await post('simulate', { revisionId: state.draft.id, draftVersion: state.draftVersion });
      return { example, state };
    });
    expect(prepared.state.evidence.passed).toBe(false);
    const ui = studio(page);
    await ui.getByRole('button', { name: 'Manage', exact: true }).click();
    await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
    await ui.getByRole('button', { name: 'Latest run', exact: true }).click();
    const first = ui.locator('.rs-example').first();
    await expect(first.locator('dl > div').first()).toHaveText('You wantedNo advice');
    await expect(first.locator('dl > div').nth(1)).toHaveText('In this exampleNeeds attention');
    await expect(first).toContainText('This example needs a correction');
    await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
    await page.evaluate(async ({ example, state }) => {
      const session = await (await fetch('/api/session')).json();
      const headers = { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken };
      const post = async (path, body) => {
        const response = await fetch(`/api/extensions/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Preparation failed: ${path}`);
        return response.json();
      };
      const next = await post('compile', { source: example.source, label: 'A different saved proposal', draftVersion: state.draftVersion });
      await post('scenarios', { revisionId: next.draft.id, cases: example.cases, draftVersion: next.draftVersion });
    }, prepared);
    await ui.getByRole('button', { name: 'Manage', exact: true }).click();
    await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
    await ui.getByText('Open a saved sample run by ID', { exact: true }).click();
    await ui.getByLabel('Evidence ID for this person', { exact: true }).fill(prepared.state.evidence.id);
    await ui.getByRole('button', { name: 'Open saved sample run', exact: true }).click();
    await expect(first.locator('dl > div').first()).toHaveText('You wantedNo advice');
    await expect(first.locator('dl > div').nth(1)).toHaveText('In this exampleNeeds attention');
    await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
    expect((await saved(page)).approved).toBe(false);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
