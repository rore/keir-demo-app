import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const changedCopy = 'The assistant settings changed, so your message wasn’t sent. Start a new conversation to continue. Your message and saved work are kept.';

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

function recordRequests(page) {
  const turns = [], setupPosts = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'POST') return;
    if (url.pathname === '/api/authoring/turn') turns.push(request.postDataJSON());
    if (url.pathname === '/api/authoring/setup') setupPosts.push(request.postDataJSON());
  });
  return { turns, setupPosts };
}

async function navigate(page, destination) {
  const mobile = page.getByRole('combobox', { name: 'Destination', exact: true });
  if (await mobile.isVisible()) await mobile.selectOption(destination.toLowerCase());
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: destination, exact: true }).click();
}

async function seedApprovedItem(page, fixture) {
  let state = await api(page, 'extensions', { operationId: crypto.randomUUID(), source: fixture.metadata.source, label: 'Saved recovery example' });
  const extensionId = state.extension.id;
  state = await api(page, `extensions/${extensionId}/scenarios`, {
    revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.metadata.cases,
  });
  state = await api(page, `extensions/${extensionId}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await api(page, `extensions/${extensionId}/approve`, {
    revisionId: state.draft.id, draftVersion: state.draftVersion, evidenceId: state.evidence.id,
  });
  expect(state.approved).toBe(true);
  expect(state.selection.revision?.extensionId).not.toBe(extensionId);
  return { extensionId, state: await api(page, `extensions/${extensionId}`), proof: await api(page, `extensions/${extensionId}/evidence/${state.approvedEvidenceId}`) };
}

async function createDiscussion(page, extensionId, saved, text) {
  const result = await api(page, 'authoring/turn', {
    target: { kind: 'revise', extensionId, baseRevisionId: saved.draft.id, selectionGeneration: saved.selection.generation },
    conversationId: null, operationId: crypto.randomUUID(), text, expectedVersion: 0, expectedDraftVersion: saved.draftVersion,
  });
  const id = result.conversation.id;
  await expect.poll(async () => (await api(page, `authoring?extensionId=${encodeURIComponent(extensionId)}`)).conversations.find(item => item.id === id)?.status)
    .toBe('AWAITING_USER');
  return id;
}

async function openStudio(page, extensionId, conversationId) {
  await page.evaluate(({ extensionId, conversationId }) => {
    const params = new URLSearchParams({ customization: extensionId });
    if (conversationId) params.set('conversation', conversationId);
    location.hash = params.toString();
  }, { extensionId, conversationId });
  await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toBeVisible();
}

async function rejectNextTurn(page, text) {
  await page.route('**/api/authoring/turn', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ code: 'CONFIG_CHANGED', message: 'Assistant settings changed.' }) }), { times: 1 });
  const composer = studio(page).getByLabel('Message to Studio', { exact: true });
  await composer.fill(text);
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/authoring/turn');
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
  expect((await response).status()).toBe(409);
  const recovery = studio(page).getByRole('article', { name: 'Assistant settings changed', exact: true });
  await expect(recovery.getByRole('status')).toHaveText(changedCopy);
  await expect(recovery.getByRole('button', { name: 'Start new conversation', exact: true })).toBeVisible();
  return recovery;
}

test('CONFIG_CHANGED preserves the sample, saved work and rejected text until an explicit fresh send', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const savedItem = await seedApprovedItem(page, fixture), calls = recordRequests(page);
    expect(fixture.requests).toEqual([]);
    await openStudio(page, savedItem.extensionId);

    const composer = studio(page).getByLabel('Message to Studio', { exact: true });
    const firstMessage = 'Keep my approved examples and help me clarify this saved change.';
    await composer.fill(firstMessage);
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/authoring/turn' && response.status() === 202);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await firstResponse;
    await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });
    const index = await api(page, `authoring?extensionId=${encodeURIComponent(savedItem.extensionId)}`);
    const oldConversationId = index.current.id;
    expect(index.current.status).toBe('AWAITING_USER');

    const checked = studio(page).getByRole('button', { name: 'Show the unfinished task example', exact: true });
    await expect(checked).toBeEnabled();
    await checked.click();
    await expect(studio(page).locator('.rs-preview')).toBeVisible();
    await expect(studio(page).getByRole('heading', { name: 'What an unfinished task would show', exact: true })).toBeVisible();

    const providerCalls = [...fixture.requests];
    const budget = fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros;
    const rejectedMessage = 'Please also explain what happens when a reply is overdue.';
    const recovery = await rejectNextTurn(page, rejectedMessage);
    await expect(studio(page).getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue(rejectedMessage);
    await expect(studio(page).locator('.rs-preview')).toBeVisible();
    await expect(studio(page).getByRole('heading', { name: 'What an unfinished task would show', exact: true })).toBeVisible();
    expect(calls.turns).toHaveLength(2);
    expect(calls.turns[1]).toMatchObject({ conversationId: oldConversationId, text: rejectedMessage, target: { kind: 'resume', extensionId: savedItem.extensionId } });
    expect(fixture.requests).toEqual(providerCalls);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros).toBe(budget);
    expect(calls.setupPosts).toEqual([]);
    expect(await api(page, `extensions/${savedItem.extensionId}`)).toEqual(savedItem.state);
    expect(await api(page, `extensions/${savedItem.extensionId}/evidence/${savedItem.state.approvedEvidenceId}`)).toEqual(savedItem.proof);

    await page.setViewportSize({ width: 390, height: 844 });
    const messageNotSent = studio(page).getByRole('button', { name: 'Message not sent', exact: true });
    await expect(messageNotSent).toBeVisible();
    await expect(studio(page).locator('.rs-header .rs-back')).toHaveAttribute('aria-label', 'Back to Customizations');
    await messageNotSent.click();
    await expect(recovery).toBeVisible();
    await expect(composer).toHaveValue(rejectedMessage);
    await recovery.getByRole('button', { name: 'Start new conversation', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(rejectedMessage);
    expect(fixture.requests).toEqual(providerCalls);

    const acceptedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/authoring/turn' && response.status() === 202);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await acceptedResponse;
    await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(calls.turns).toHaveLength(3);
    expect(calls.turns[2]).toEqual({ conversationId: null, operationId: expect.any(String), text: rejectedMessage,
      expectedVersion: 0, expectedDraftVersion: savedItem.state.draftVersion,
      target: { kind: 'revise', extensionId: savedItem.extensionId, baseRevisionId: savedItem.state.draft.id, selectionGeneration: savedItem.state.selection.generation } });
    expect(fixture.requests).toHaveLength(providerCalls.length + 2);
    await expect(recovery).toHaveCount(0);

    const newIndex = await api(page, `authoring?extensionId=${encodeURIComponent(savedItem.extensionId)}`);
    expect(newIndex.current.id).not.toBe(oldConversationId);
    expect(newIndex.conversations.map(item => item.id)).toContain(oldConversationId);
    const oldHistory = await api(page, `authoring/conversations/${encodeURIComponent(oldConversationId)}`);
    expect(oldHistory.messages.map(item => item.text)).toContain(firstMessage);
    expect(oldHistory.messages.map(item => item.text)).not.toContain(rejectedMessage);
    expect(await api(page, `extensions/${savedItem.extensionId}`)).toEqual(savedItem.state);
    expect(await api(page, `extensions/${savedItem.extensionId}/evidence/${savedItem.state.approvedEvidenceId}`)).toEqual(savedItem.proof);
  } finally { await fixture.close(); }
});

test('adopting another saved discussion clears recovery and owner switching does not leak its text', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const savedItem = await seedApprovedItem(page, fixture);
    const oldConversationId = await createDiscussion(page, savedItem.extensionId, savedItem.state, 'Earlier discussion for this saved customization.');
    const currentConversationId = await createDiscussion(page, savedItem.extensionId, savedItem.state, 'Current saved discussion for this customization.');
    const calls = recordRequests(page);
    const providerCalls = [...fixture.requests];
    await openStudio(page, savedItem.extensionId, currentConversationId);
    const rejectedMessage = 'Keep this message while the saved discussions stay available.';
    const recovery = await rejectNextTurn(page, rejectedMessage);
    expect(calls.turns).toHaveLength(1);
    expect(fixture.requests).toEqual(providerCalls);

    await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
    const conversations = studio(page).getByLabel('Saved authoring conversation', { exact: true });
    await expect(conversations).toBeVisible();
    await conversations.selectOption(oldConversationId);
    await expect(conversations).toHaveValue(oldConversationId);
    await expect(recovery).toHaveCount(0);
    await expect(studio(page).getByText('Earlier discussion for this saved customization.', { exact: true })).toBeVisible();

    await page.getByLabel('Demo person', { exact: true }).selectOption('sam');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('sam');
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toHaveValue('');
    await expect(studio(page).getByRole('article', { name: 'Assistant settings changed', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(rejectedMessage);
    expect(calls.setupPosts).toEqual([]);
    expect(fixture.requests).toEqual(providerCalls);

    await page.getByLabel('Demo person', { exact: true }).selectOption('maya');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    expect(await api(page, `extensions/${savedItem.extensionId}`)).toEqual(savedItem.state);
    expect((await api(page, `authoring?extensionId=${encodeURIComponent(savedItem.extensionId)}`)).conversations.map(item => item.id)).toContain(oldConversationId);
    expect((await api(page, `authoring/conversations/${encodeURIComponent(oldConversationId)}`)).status).toBe('AWAITING_USER');
  } finally { await fixture.close(); }
});
