import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const changedCopy = 'Assistant settings changed. Your message is kept. Send it again when you’re ready.';

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
  const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Saved recovery example' });
  let state = await api(page, `extensions/${extensionId}/compile`, { hookId: 'TaskCompleted', source: fixture.metadata.source, label: 'Saved recovery example', draftVersion: 0 });
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
  await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toBeVisible();
}

async function rejectNextTurn(page, text) {
  await page.route('**/api/authoring?extensionId=*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), current: null } });
  }, { times: 1 });
  await page.route('**/api/authoring/turn', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ code: 'CONFIG_CHANGED', message: 'Assistant settings changed.' }) }), { times: 1 });
  const composer = studio(page).getByLabel('Message to Daymark assistant', { exact: true });
  await composer.fill(text);
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/authoring/turn');
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
  expect((await response).status()).toBe(409);
  const recovery = studio(page).getByRole('alert').filter({ hasText: changedCopy });
  await expect(recovery).toHaveText(changedCopy);
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

    const composer = studio(page).getByLabel('Message to Daymark assistant', { exact: true });
    const firstMessage = 'Keep my approved examples and help me clarify this saved change.';
    await composer.fill(firstMessage);
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/authoring/turn' && response.status() === 202);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await firstResponse;
    await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });
    const index = await api(page, `authoring?extensionId=${encodeURIComponent(savedItem.extensionId)}`);
    const oldConversationId = index.current.id;
    expect(index.current.status).toBe('AWAITING_USER');

    await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
    await studio(page).getByText('Saved sample runs', { exact: true }).click();
    await studio(page).getByRole('button', { name: 'Open saved sample run 1', exact: true }).click();
    await expect(studio(page).locator('.rs-preview')).toBeVisible();
    await expect(studio(page).getByRole('heading', { name: `Saved example: Completed task in “${fixture.metadata.projectName}”`, exact: true })).toBeVisible();

    const providerCalls = [...fixture.requests];
    const budget = fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros;
    const rejectedMessage = 'Please also explain what happens when a reply is overdue.';
    const recovery = await rejectNextTurn(page, rejectedMessage);
    await expect(studio(page).getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue(rejectedMessage);
    await expect(studio(page).locator('.rs-preview')).toBeVisible();
    await expect(studio(page).getByRole('heading', { name: `Saved example: Completed task in “${fixture.metadata.projectName}”`, exact: true })).toBeVisible();
    expect(calls.turns).toHaveLength(2);
    expect(calls.turns[1]).toMatchObject({ conversationId: oldConversationId, text: rejectedMessage, target: { kind: 'resume', extensionId: savedItem.extensionId } });
    expect(fixture.requests).toEqual(providerCalls);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros).toBe(budget);
    expect(calls.setupPosts).toEqual([]);
    expect(await api(page, `extensions/${savedItem.extensionId}`)).toEqual(savedItem.state);
    expect(await api(page, `extensions/${savedItem.extensionId}/evidence/${savedItem.state.approvedEvidenceId}`)).toEqual(savedItem.proof);

    await page.setViewportSize({ width: 390, height: 844 });
    const backToConversation = studio(page).getByRole('button', { name: 'Back to conversation', exact: true });
    await expect(backToConversation).toBeVisible();
    await expect(studio(page).locator('.rs-header .rs-back')).toHaveAttribute('aria-label', 'Back to Customizations');
    await backToConversation.click();
    await expect(recovery).toBeVisible();
    await expect(composer).toHaveValue(rejectedMessage);
    await expect(studio(page).getByText(firstMessage, { exact: true })).toBeVisible();
    expect(fixture.requests).toEqual(providerCalls);

    const acceptedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/authoring/turn' && response.status() === 202);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await acceptedResponse;
    await expect(studio(page).getByText(rejectedMessage, { exact: true })).toBeVisible();
    await expect.poll(() => fixture.requests.length).toBe(providerCalls.length + 2);
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

test('one item shows its saved discussions and owner switching does not leak recovery text', async ({ page }) => {
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
    await rejectNextTurn(page, rejectedMessage);
    expect(calls.turns).toHaveLength(1);
    expect(fixture.requests).toEqual(providerCalls);

    await expect(studio(page).getByText('Earlier discussion for this saved customization.', { exact: true })).toBeVisible();
    await expect(studio(page).getByText('Current saved discussion for this customization.', { exact: true })).toBeVisible();
    await expect(studio(page).getByLabel('Saved authoring conversation', { exact: true })).toHaveCount(0);

    await page.getByLabel('Demo person', { exact: true }).selectOption('sam');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('sam');
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('');
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

test('a revised customization opens its earlier discussion and continues in one transcript', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const { extensionId, state, proof } = await seedApprovedItem(page, fixture);
    const text = 'Earlier discussion for this saved customization.';
    const conversationId = await createDiscussion(page, extensionId, state, text);
    const previous = 'An earlier checked result is still part of this conversation.';
    const insertMessage = fixture.db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)');
    insertMessage.run(conversationId, 'maya', 3, 'earlier-proof',
      JSON.stringify({ id: 'earlier-proof', role: 'assistant', text: previous, kind: 'review',
        receipt: { revisionId: state.draft.id, draftVersion: state.draftVersion, suiteDigest: state.draft.suiteDigest, evidenceId: proof.id } }));
    for (let sequence = 4; sequence <= 21; sequence++) {
      const id = 'retained-' + sequence;
      insertMessage.run(conversationId, 'maya', sequence, id,
        JSON.stringify({ id, role: 'assistant', kind: 'text', text: 'Earlier saved message ' + sequence }));
    }
    const fresh = await api(page, `extensions/${extensionId}/compile`, { hookId: 'TaskCompleted', source: fixture.metadata.source + '\n\n', draftVersion: state.draftVersion });
    const calls = recordRequests(page), providerCalls = fixture.requests.length;
    const budget = fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros;
    const index = await api(page, `authoring?extensionId=${extensionId}`);
    expect(index.current).toBeNull();

    await page.goto(`${fixture.origin}/#customization=${extensionId}`);
    const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
    const loadEarlier = () => ui.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(ui.getByText(previous, { exact: true })).toBeVisible();
    await loadEarlier();
    await expect(ui.getByText(text, { exact: true })).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(ui.getByLabel('Saved authoring conversation', { exact: true })).toHaveCount(0);
    await ui.getByRole('button', { name: 'View earlier examples', exact: true }).click();
    await expect(ui.getByText('Earlier example · this does not approve your current changes.', { exact: false })).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    expect(calls.turns).toEqual([]);
    expect(fixture.requests).toHaveLength(providerCalls);
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros).toBe(budget);

    const exactPath = '/api/authoring/conversations/' + conversationId, exactReads = [];
    page.on('request', request => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === exactPath) exactReads.push(request.url());
    });
    await page.route('**' + exactPath, route => route.fulfill({ status: 503, json: { message: 'Temporarily unavailable' } }), { times: 1 });
    await page.evaluate(({ extensionId, conversationId }) => {
      location.hash = new URLSearchParams({ customization: extensionId, conversation: conversationId }).toString();
    }, { extensionId, conversationId });
    const exactHash = '#customization=' + extensionId + '&conversation=' + conversationId;
    await expect(ui.getByRole('alert')).toContainText('AI authoring status could not be checked.');
    expect(new URL(page.url()).hash).toBe(exactHash);
    await ui.getByRole('button', { name: 'Retry status', exact: true }).click();
    await expect(ui.getByText(previous, { exact: true })).toBeVisible();
    expect(exactReads).toHaveLength(2);
    expect(new URL(page.url()).hash).toBe(exactHash);
    await expect(ui.getByRole('article', { name: 'Retired customization', exact: true })).toHaveCount(0);
    await expect(composer).toBeHidden();
    await ui.getByRole('button', { name: 'Return to current changes', exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(page).toHaveURL(new RegExp('#customization=' + extensionId + '$'));
    await loadEarlier();
    await expect(ui.getByText(text, { exact: true })).toHaveCount(1);
    expect(fixture.requests).toHaveLength(providerCalls);
    const followUp = 'Keep the original behavior and discuss the current task customization.';
    await composer.fill(followUp);
    await ui.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await api(page, `authoring?extensionId=${extensionId}`)).current?.status).toBe('AWAITING_USER');
    expect(calls.turns).toEqual([{ conversationId: null, operationId: expect.any(String), text: followUp,
      expectedVersion: 0, expectedDraftVersion: fresh.draftVersion,
      target: { kind: 'revise', extensionId, baseRevisionId: fresh.draft.id, selectionGeneration: fresh.selection.generation } }]);
    await expect(ui.getByText(text, { exact: true })).toHaveCount(1);
    await expect(ui.getByText(followUp, { exact: true })).toHaveCount(1);
    await page.reload();
    await loadEarlier();
    await expect(ui.getByText(text, { exact: true })).toHaveCount(1);
    await expect(ui.getByText(previous, { exact: true })).toHaveCount(1);
    await expect(ui.getByText(followUp, { exact: true })).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp('#customization=' + extensionId + '$'));
    expect(await api(page, 'extensions/' + extensionId)).toEqual(fresh);
    expect(await api(page, `extensions/${extensionId}/evidence/${proof.id}`)).toEqual(proof);
    expect(fixture.requests).toHaveLength(providerCalls + 2);
  } finally { await fixture.close(); }
});
