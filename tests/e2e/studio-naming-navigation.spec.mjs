import { test, expect } from '@playwright/test';
import { openDeveloperTools } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });

async function api(page, path, body) {
  const response = await page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Session-Context': session.contextToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, text: await response.text() };
  }, { path, body });
  expect(response.ok, response.text).toBe(true);
  return JSON.parse(response.text);
}

async function createRequest(page, text) {
  const result = await api(page, 'authoring/turn', {
    target: { kind: 'create' }, conversationId: null, operationId: crypto.randomUUID(), text,
    expectedVersion: 0, expectedDraftVersion: 0,
  });
  expect(result.conversation.extensionId).toBeTruthy();
  await expect.poll(async () => (await api(page, `authoring?extensionId=${encodeURIComponent(result.conversation.extensionId)}`)).current?.status)
    .toBe('AWAITING_USER');
  return result.conversation.extensionId;
}

async function navigate(page, destination) {
  await page.getByLabel('Destination', { exact: true }).selectOption(destination.toLowerCase());
}

test('untitled items show their request and returning from sample history resets collection scroll', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  try {
    await page.setViewportSize({ width: 683, height: 384 });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible();

    const firstRequest = 'Keep track of the materials I still need.';
    const secondRequest = 'Show which orders are waiting for a reply.';
    const firstId = await createRequest(page, firstRequest);
    await navigate(page, 'Customizations');
    const cards = page.locator('.customization-card').filter({ hasText: 'Untitled customization' });
    await expect(cards).toHaveCount(1);
    const discussion = cards.locator('details.customization-discussion');
    await expect(discussion).toHaveCount(1);
    await discussion.getByText('Discussion started with', { exact: true }).click();
    await expect(discussion.locator('p')).toHaveText(firstRequest);
    await navigate(page, 'Tasks');
    const secondId = await createRequest(page, secondRequest);
    let saved = await api(page, `extensions/${secondId}/compile`, {
      hookId: 'TaskCompleted', source: fixture.metadata.source, label: 'Saved sample history', draftVersion: 0,
    });
    saved = await api(page, `extensions/${secondId}/scenarios`, {
      revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases: fixture.metadata.cases,
    });
    saved = await api(page, `extensions/${secondId}/simulate`, {
      revisionId: saved.draft.id, draftVersion: saved.draftVersion,
    });
    expect(saved.evidence.passed).toBe(true);

    await navigate(page, 'Customizations');
    await expect(cards).toHaveCount(2);
    for (const [itemId, excerpt] of [[firstId, firstRequest], [secondId, secondRequest]]) {
      const card = cards.filter({ has: page.locator(`#edit-${itemId}`) });
      await expect(card.getByRole('heading', { name: 'Untitled customization', exact: true })).toBeVisible();
      await expect(card).toContainText(excerpt);
    }

    const collection = page.locator('.customizations-main');
    await collection.evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect(await collection.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.locator(`#edit-${secondId}`).click();
    await studio(page).getByRole('button', { name: 'Rename', exact: true }).scrollIntoViewIfNeeded();
    await expect(studio(page).getByRole('button', { name: 'Rename', exact: true })).toBeInViewport({ ratio: 1 });
    await studio(page).getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    const savedRuns = studio(page).getByText('Saved sample runs', { exact: true });
    await savedRuns.click();
    const openRun = studio(page).getByRole('button', { name: 'Open saved sample run 1', exact: true });
    await openRun.click();
    const results = studio(page).getByRole('article', { name: 'Sample results', exact: true });
    await results.locator('.rs-example-details summary').click();
    await expect(results.getByText(`Evidence: ${saved.evidence.id}`, { exact: true })).toBeVisible();
    await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(studio(page).getByRole('button', { name: 'More', exact: true })).toBeFocused();

    await studio(page).getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible();
    await expect.poll(() => collection.evaluate(node => node.scrollTop)).toBe(0);
    const routePosition = await page.evaluate(() => ({
      windowY: window.scrollY,
      documentY: document.scrollingElement?.scrollTop ?? 0,
      workspaceTop: document.querySelector('.workspace-top')?.getBoundingClientRect().top ?? null,
      workspaceBodyTop: document.querySelector('.workspace-body')?.getBoundingClientRect().top ?? null,
    }));
    expect(routePosition.windowY).toBe(0);
    expect(routePosition.documentY).toBe(0);
    expect(routePosition.workspaceTop).not.toBeNull();
    expect(routePosition.workspaceBodyTop).not.toBeNull();
    expect(routePosition.workspaceTop).toBeGreaterThanOrEqual(routePosition.workspaceBodyTop);

    await page.locator(`#edit-${secondId}`).click();
    await studio(page).getByRole('button', { name: 'More', exact: true }).click();
    await openDeveloperTools(page);
    await studio(page).getByText('Saved sample runs', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    const restoredResults = studio(page).getByRole('article', { name: 'Sample results', exact: true });
    await restoredResults.locator('.rs-example-details summary').click();
    await expect(restoredResults.getByText(`Evidence: ${saved.evidence.id}`, { exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(4);
  } finally { await fixture.close(); }
});
