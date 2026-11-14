import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const nav = page => page.getByRole('navigation', { name: 'Main navigation' });
const personSelect = page => page.getByRole('combobox', { name: 'Demo person', exact: true });
const turnRequest = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/authoring/turn';
const evidenceDir = resolve('build/studio-extension-creation');

async function enterNewStudio(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya', exact: false }).click();
  await nav(page).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  return studio(page);
}

async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.contextToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} user=${JSON.stringify(session.user)} ${JSON.stringify(data)}`);
    return data;
  }, { path, body });
}

async function createActiveCustomization(page, fixture) {
  const example = fixture.metadata;
  const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Prior synthetic customization' });
  let state = await api(page, `extensions/${extensionId}/compile`, { hookId: 'TaskCompleted', source: example.source, label: 'Prior synthetic customization', draftVersion: 0 });
  state = await api(page, `extensions/${extensionId}/scenarios`, {
    revisionId: state.draft.id, cases: example.cases, draftVersion: state.draftVersion,
  });
  state = await api(page, `extensions/${extensionId}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
  expect(state.evidence.passed).toBe(true);
  state = await api(page, `extensions/${extensionId}/approve`, {
    revisionId: state.draft.id, draftVersion: state.draftVersion, evidenceId: state.evidence.id,
  });
  state = await api(page, `extensions/${extensionId}/activate`, {
    revisionId: state.draft.id, draftVersion: state.draftVersion, generation: state.selection.generation, evidenceId: state.approvedEvidenceId,
  });
  const saved = await api(page, `extensions/${extensionId}/revisions/${state.draft.id}`);
  return { extensionId, revisionId: state.draft.id, source: saved.source, cases: saved.cases, state };
}

async function saveCandidate(page, extensionId, source, cases, label) {
  let state = await api(page, `extensions/${extensionId}/compile`, { hookId: 'TaskCompleted', source, label, draftVersion: 0 });
  state = await api(page, `extensions/${extensionId}/scenarios`, {
    revisionId: state.draft.id, cases, draftVersion: state.draftVersion,
  });
  state = await api(page, `extensions/${extensionId}/simulate`, { revisionId: state.draft.id, draftVersion: state.draftVersion });
  expect(state.evidence.passed).toBe(true);
  return state;
}

async function noTurnRequest(page, timeout = 400) {
  let requested = false;
  try { await page.waitForRequest(turnRequest, { timeout }); requested = true; }
  catch (error) { if (error.name !== 'TimeoutError') throw error; }
  expect(requested).toBe(false);
}

async function switchPerson(page, id) {
  const select = personSelect(page);
  if (await select.count()) await select.selectOption(id);
  await expect(personSelect(page)).toBeVisible({ timeout: 15_000 });
  await expect(personSelect(page)).toHaveValue(id, { timeout: 15_000 });
}

test('top-level New starts a distinct customization after a real prior chat and saved item', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ provider: 'anthropic', intentResolutions: ['prepare', 'prepare', 'prepare'] });
  mkdirSync(evidenceDir, { recursive: true });
  const turns = [];
  page.on('request', request => { if (turnRequest(request)) turns.push(request.postDataJSON()); });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya', exact: false }).click();
    await expect(nav(page).getByRole('button', { name: 'Customizations', exact: true })).toBeVisible();
    const prior = await createActiveCustomization(page, fixture);
    const collectionBefore = await api(page, 'extensions');
    expect(collectionBefore.items.map(item => item.extension.id)).toContain(prior.extensionId);
    const priorItemBefore = collectionBefore.items.find(item => item.extension.id === prior.extensionId);
    expect(collectionBefore.selection.revision.extensionId).toBe(prior.extensionId);

    await nav(page).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.locator(`#edit-${prior.extensionId}`).click();
    const editStudio = studio(page);
    await editStudio.getByLabel('Message to Daymark assistant', { exact: true }).fill('Prior saved conversation for the synthetic regression.');
    const priorAccepted = page.waitForResponse(response => turnRequest(response.request()));
    await editStudio.getByRole('button', { name: 'Send', exact: true }).click();
    const priorResponse = await priorAccepted;
    expect(priorResponse.status()).toBe(202);
    const priorAcceptedBody = await priorResponse.json();
    await expect(editStudio.getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });
    const priorConversation = turns[0];
    expect(priorConversation.target).toMatchObject({ kind: 'revise', extensionId: prior.extensionId });
    const sourceAndCasesBefore = await api(page, `extensions/${prior.extensionId}/revisions/${prior.revisionId}`);

    await nav(page).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const newStudio = studio(page);
    const log = newStudio.getByRole('log', { name: 'Studio conversation', exact: true });
    await expect(log).toBeVisible();
    const blankLog = await log.innerText();
    expect(blankLog).not.toContain('Prior saved conversation for the synthetic regression.');
    expect(blankLog).not.toContain(fixture.metadata.question);
    await expect(newStudio.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('');

    await newStudio.getByLabel('Message to Daymark assistant', { exact: true }).fill('A distinct new customization request.');
    const creationAccepted = page.waitForResponse(response => turnRequest(response.request()));
    await newStudio.getByRole('button', { name: 'Send', exact: true }).click();
    const acceptedResponse = await creationAccepted;
    expect(acceptedResponse.status()).toBe(202);
    const accepted = await acceptedResponse.json();
    const createTurn = turns[1];
    expect(createTurn).toMatchObject({ target: { kind: 'create' }, conversationId: null,
      text: 'A distinct new customization request.', expectedVersion: 0 });
    expect(accepted.conversation.extensionId).toBeTruthy();
    expect(accepted.conversation.extensionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(accepted.conversation.extensionId).not.toBe(prior.extensionId);
    expect(createTurn.expectedDraftVersion).toBe(0);
    await expect(newStudio.getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });

    const example = fixture.metadata;
    const savedB = await saveCandidate(page, accepted.conversation.extensionId, example.source, example.cases, 'Saved B candidate');
    const bStateBeforeEdit = await api(page, `extensions/${accepted.conversation.extensionId}`);
    const bSourceBeforeEdit = await api(page, `extensions/${accepted.conversation.extensionId}/revisions/${savedB.draft.id}`);

    const collectionAfter = await api(page, 'extensions');
    const newItem = collectionAfter.items.find(item => item.extension.id === accepted.conversation.extensionId);
    expect(newItem).toBeTruthy();
    expect(collectionAfter.items.find(item => item.extension.id === prior.extensionId)).toEqual(priorItemBefore);
    expect(collectionAfter.selection).toEqual(collectionBefore.selection);
    const sourceAndCasesAfter = await api(page, `extensions/${prior.extensionId}/revisions/${prior.revisionId}`);
    expect(sourceAndCasesAfter).toEqual(sourceAndCasesBefore);
    expect(sourceAndCasesAfter).toMatchObject({ source: prior.source, cases: prior.cases });

    await nav(page).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.locator(`#edit-${prior.extensionId}`).click();
    const reopenA = studio(page);
    await reopenA.getByLabel('Message to Daymark assistant', { exact: true }).fill('Yes, keep the independent examples and show me Done for completed tasks.');
    await reopenA.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reopenA.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 25_000 });
    const bStateAfterEdit = await api(page, `extensions/${accepted.conversation.extensionId}`);
    const bSourceAfterEdit = await api(page, `extensions/${accepted.conversation.extensionId}/revisions/${savedB.draft.id}`);
    expect(bStateAfterEdit).toEqual(bStateBeforeEdit);
    expect(bSourceAfterEdit).toEqual(bSourceBeforeEdit);

    expect(fixture.db.prepare('SELECT owner_id FROM extensions WHERE id=?').get(prior.extensionId)?.owner_id).toBe('maya');
    expect(fixture.db.prepare('SELECT owner_id FROM extensions WHERE id=?').get(accepted.conversation.extensionId)?.owner_id).toBe('maya');
    expect(fixture.db.prepare('SELECT owner_id,extension_id,purpose FROM extension_conversation_links WHERE conversation_id=?')
      .get(priorAcceptedBody.conversation.id)).toEqual({ owner_id: 'maya', extension_id: prior.extensionId, purpose: 'REVISE' });
    expect(fixture.db.prepare('SELECT owner_id,extension_id,purpose FROM extension_conversation_links WHERE conversation_id=?')
      .get(accepted.conversation.id)).toEqual({ owner_id: 'maya', extension_id: accepted.conversation.extensionId, purpose: 'CREATE' });

    writeFileSync(resolve(evidenceDir, 'creation-new.json'), JSON.stringify({
      oldExtensionId: prior.extensionId, newExtensionId: accepted.conversation.extensionId,
      priorConversation, createTurn, priorRevisionId: prior.revisionId,
      sourceAndCasesPreserved: true, selectionPreserved: true, bCandidateRevisionId: savedB.draft.id,
      reopenedAWhileBUnchanged: true, blankLog,
    }, null, 2));
  } finally { await fixture.close(); }
});

test('Enter sends once; Shift+Enter, IME, repeat, empty and running guards do not submit', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await startAuthoringFixture({ provider: 'anthropic' });
  mkdirSync(evidenceDir, { recursive: true });
  const posts = [];
  let releaseRequest;
  page.on('request', request => { if (turnRequest(request)) posts.push(request.postDataJSON()); });
  try {
    const ui = await enterNewStudio(page, fixture.origin);
    const composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
    await composer.focus();
    await page.keyboard.press('Enter');
    await noTurnRequest(page);

    await composer.fill('First line');
    await page.keyboard.press('Shift+Enter');
    await expect(composer).toHaveValue('First line\n');
    await noTurnRequest(page);

    for (const init of [
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229, which: 229 },
      { key: 'Enter', repeat: true },
    ]) {
      await page.evaluate(init => {
        document.querySelector('#studio-message').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
      }, init);
      await noTurnRequest(page);
    }

    await composer.fill('Send this synthetic request with Enter.');
    const held = new Promise(resolve => { releaseRequest = resolve; });
    await page.route('**/api/authoring/turn', async route => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    const entered = page.waitForRequest(turnRequest);
    await page.keyboard.press('Enter');
    const request = await entered;
    expect(request.postDataJSON()).toMatchObject({ target: { kind: 'create' }, conversationId: null,
      text: 'Send this synthetic request with Enter.' });

    await composer.fill('Do not send while the first request is running.');
    await page.keyboard.press('Enter');
    await noTurnRequest(page);
    expect(posts).toHaveLength(1);
    releaseRequest();
    const response = await request.response();
    expect(response.status()).toBe(202);
    writeFileSync(resolve(evidenceDir, 'creation-keyboard.json'), JSON.stringify({ posts, responseStatus: response.status() }, null, 2));
  } finally { releaseRequest?.(); await fixture.close(); }
});

test('a lost create receipt recovers by operation identity and reload does not replay it', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ provider: 'anthropic' });
  mkdirSync(evidenceDir, { recursive: true });
  const posts = [];
  let dropped;
  page.on('request', request => { if (turnRequest(request)) posts.push(request.postDataJSON()); });
  try {
    const ui = await enterNewStudio(page, fixture.origin);
    const composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
    await composer.fill('Keep this request if its first response is lost.');
    await page.route('**/api/authoring/turn', async route => {
      const response = await route.fetch();
      dropped = { status: response.status(), body: await response.json() };
      await route.abort('failed');
    }, { times: 1 });
    const requestSeen = page.waitForRequest(turnRequest);
    await ui.getByRole('button', { name: 'Send', exact: true }).click();
    const firstRequest = await requestSeen;
    await expect.poll(() => dropped?.status).toBe(202);
    const turn = firstRequest.postDataJSON();
    expect(turn).toMatchObject({ target: { kind: 'create' }, conversationId: null,
      text: 'Keep this request if its first response is lost.', expectedVersion: 0, expectedDraftVersion: 0 });
    expect(dropped.body.operation.id).toBe(turn.operationId);
    expect(dropped.body.conversation.extensionId).toBeTruthy();
    await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(posts).toHaveLength(1);

    const extension = fixture.db.prepare('SELECT id,owner_id,creation_operation_id FROM extensions WHERE owner_id=? AND creation_operation_id=?')
      .get('maya', turn.operationId);
    expect(extension).toEqual({ id: dropped.body.conversation.extensionId, owner_id: 'maya', creation_operation_id: turn.operationId });
    const conversations = fixture.db.prepare('SELECT id,owner_id,creation_operation_id,status FROM authoring_conversations WHERE owner_id=?').all('maya');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ id: dropped.body.conversation.id, owner_id: 'maya', creation_operation_id: turn.operationId, status: 'AWAITING_USER' });
    expect(fixture.db.prepare('SELECT owner_id,extension_id,purpose FROM extension_conversation_links WHERE conversation_id=?')
      .get(dropped.body.conversation.id)).toEqual({ owner_id: 'maya', extension_id: extension.id, purpose: 'CREATE' });
    expect(fixture.requests.map(item => item.name)).toEqual(['resolve_intent', 'discover_catalog', 'ask_clarification']);

    await page.reload();
    const reopened = studio(page), reopenedLog = reopened.getByRole('log', { name: 'Studio conversation', exact: true });
    await expect(reopenedLog.getByText('Keep this request if its first response is lost.', { exact: true })).toHaveCount(1);
    await expect(reopenedLog.getByText(fixture.metadata.question, { exact: true })).toHaveCount(1);
    expect(posts).toHaveLength(1);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM extensions WHERE owner_id=? AND creation_operation_id=?').get('maya', turn.operationId).n).toBe(1);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM authoring_conversations WHERE owner_id=? AND creation_operation_id=?').get('maya', turn.operationId).n).toBe(1);
    expect(fixture.requests.map(item => item.name)).toEqual(['resolve_intent', 'discover_catalog', 'ask_clarification']);

    writeFileSync(resolve(evidenceDir, 'creation-recovery.json'), JSON.stringify({
      operationId: turn.operationId, extensionId: extension.id, conversationId: dropped.body.conversation.id,
      firstResponseStatus: dropped.status, postCountAfterReload: posts.length,
      extensionCountForOperation: 1, conversationCountForOperation: 1,
      syntheticProviderTools: fixture.requests.map(item => item.name), recoveredByExactOperation: true,
    }, null, 2));
  } finally { await fixture.close(); }
});

test('an exact Maya conversation link and delayed Maya responses stay isolated from Sam', async ({ page }) => {
  test.setTimeout(75_000);
  const fixture = await startAuthoringFixture({ provider: 'anthropic' });
  mkdirSync(evidenceDir, { recursive: true });
  const posts = [];
  let releaseAccepted;
  const holdAccepted = new Promise(resolve => { releaseAccepted = resolve; });
  let acceptedResolve;
  const acceptedSeen = new Promise(resolve => { acceptedResolve = resolve; });
  let acceptedResponse;
  page.on('request', request => { if (turnRequest(request)) posts.push(request.postDataJSON()); });
  try {
    const ui = await enterNewStudio(page, fixture.origin);
    await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Maya private request for the delayed-link regression.');
    await page.route('**/api/authoring/turn', async route => {
      const response = await route.fetch();
      acceptedResponse = { status: response.status(), body: await response.json() };
      acceptedResolve();
      await holdAccepted;
      try { await route.fulfill({ response }); } catch { /* Switching owner may abort the old browser request. */ }
    }, { times: 1 });
    await ui.getByRole('button', { name: 'Send', exact: true }).click();
    await acceptedSeen;
    expect(acceptedResponse.status).toBe(202);
    const turn = posts[0];
    expect(turn).toMatchObject({ target: { kind: 'create' }, conversationId: null,
      text: 'Maya private request for the delayed-link regression.', expectedVersion: 0 });
    expect(acceptedResponse.body.operation.id).toBe(turn.operationId);
    const extensionId = acceptedResponse.body.conversation.extensionId;
    const conversationId = acceptedResponse.body.conversation.id;
    expect(fixture.db.prepare('SELECT owner_id,creation_operation_id FROM extensions WHERE id=?').get(extensionId))
      .toEqual({ owner_id: 'maya', creation_operation_id: turn.operationId });
    expect(fixture.db.prepare('SELECT owner_id,extension_id,purpose FROM extension_conversation_links WHERE conversation_id=?').get(conversationId))
      .toEqual({ owner_id: 'maya', extension_id: extensionId, purpose: 'CREATE' });
    const exactLink = `${fixture.origin}/#customization=${encodeURIComponent(extensionId)}&conversation=${encodeURIComponent(conversationId)}`;

    await switchPerson(page, 'sam');
    releaseAccepted();
    await expect(page.getByText('Maya private request for the delayed-link regression.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(fixture.metadata.question, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Customization Studio', exact: true })).toHaveCount(0);

    // The saved identity belongs to Maya. Sam can follow the exact link, but sees only a generic fallback.
    await page.goto(exactLink);
    await expect(personSelect(page)).toHaveValue('sam');
    await expect(page.getByRole('heading', { name: 'Customizations', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`#edit-${extensionId}`)).toHaveCount(0);
    await expect(page.getByText('Maya private request for the delayed-link regression.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(fixture.metadata.question, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/That customization or conversation is unavailable/)).toBeVisible();

    // Hold an authenticated Maya status response, change to Sam, and release the stale response afterward.
    await switchPerson(page, 'maya');
    let releaseStatus;
    let statusResolve;
    const heldStatus = new Promise(resolve => { releaseStatus = resolve; });
    const statusSeen = new Promise(resolve => { statusResolve = resolve; });
    let heldStatusData;
    await page.route('**/api/authoring*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname !== '/api/authoring') return route.continue();
      const response = await route.fetch();
      heldStatusData = { status: response.status(), body: await response.json() };
      statusResolve();
      await heldStatus;
      try { await route.fulfill({ response }); } catch { /* The owner-scoped request may be cancelled on account change. */ }
    }, { times: 1 });
    await page.goto(exactLink);
    expect(page.url()).toBe(exactLink);
    await page.reload();
    await statusSeen;
    expect(heldStatusData.status).toBe(200);
    expect(heldStatusData.body.conversations.some(item => item.id === conversationId && item.extensionId === extensionId)).toBe(true);
    await switchPerson(page, 'sam');
    releaseStatus();
    await expect(page.getByText('Maya private request for the delayed-link regression.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(fixture.metadata.question, { exact: true })).toHaveCount(0);
    await expect(page.locator(`#edit-${extensionId}`)).toHaveCount(0);

    await switchPerson(page, 'maya');
    await page.goto(exactLink);
    const resumed = studio(page), log = resumed.getByRole('log', { name: 'Studio conversation', exact: true });
    await expect(log.getByText('Maya private request for the delayed-link regression.', { exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect(log.getByText(fixture.metadata.question, { exact: true })).toHaveCount(1, { timeout: 20_000 });
    expect(posts).toHaveLength(1);
    expect(posts[0].operationId).toBe(turn.operationId);
    expect(fixture.requests.map(item => item.name)).toEqual(['resolve_intent', 'discover_catalog', 'ask_clarification']);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM extensions WHERE owner_id=? AND creation_operation_id=?').get('maya', turn.operationId).n).toBe(1);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM authoring_conversations WHERE owner_id=? AND creation_operation_id=?').get('maya', turn.operationId).n).toBe(1);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM authoring_conversations WHERE owner_id=?').get('sam').n).toBe(0);

    writeFileSync(resolve(evidenceDir, 'creation-owner-switch.json'), JSON.stringify({
      owner: 'maya', otherOwner: 'sam', extensionId, conversationId, operationId: turn.operationId,
      exactLinkReturnedGenericFallbackForSam: true, delayedAcceptedResponseReleasedAfterSwitch: true,
      delayedStatusOwnerAndConversation: { owner: 'maya', conversationId },
      mayaResumedOriginalConversation: true, postCount: posts.length,
      syntheticProviderTools: fixture.requests.map(item => item.name),
    }, null, 2));
  } finally { releaseAccepted(); await fixture.close(); }
});
