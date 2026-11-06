import { test as base, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

// The public job protocol is scripted here; this fixture does not qualify the real backend/provider loop.
const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'keir-authoring-browser-'));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let server;
    try {
      server = await start({ directory, port });
      const lifecycle = createLifecycle(server.db);
      const extensionIds = Object.fromEntries(['maya', 'leo', 'sam'].map(owner => [owner,
        admitTaskDraft(server.db, lifecycle, { owner, name: `${owner} test customization` }).extensionId]));
      await use({ origin: server.origin, extensionIds });
    } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const authoring = studio;
const available = { available: true, code: null, provider: 'openai', model: 'test-model' };
const unavailable = { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null };

function conversation(extensionId, id, version, status, messages, { runId = `run-${id}`, operation, draftVersion = 0, review = null } = {}) {
  return { id, extensionId, purpose: 'REVISE', version, status, runId, operation: operation ?? { id: `operation-${id}`, runId, version },
    messages, code: null, review, draft: { revisionId: null, draftVersion, suiteDigest: null },
    selection: { revisionId: null, generation: 0 } };
}

function message(id, role, text, kind = 'text') { return { id, role, text, kind }; }

async function scriptAuthoring(page, { extensionId, availability = available, onTurn, onRead, onCancel, onRecover } = {}) {
  const calls = { turns: [], reads: [], cancels: [], recoveries: [] };
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = async (body, status = 200) => {
      try { return await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
      catch (error) { if (request.failure()) return; throw error; }
    };
    if (url.pathname === '/api/authoring' && method === 'GET') {
      const value = onRead ? await onRead(calls) : { availability, conversations: [], current: null };
      const scope = url.searchParams.get('extensionId');
      const summaries = value.conversations.map(item => ({ extensionId, purpose: 'REVISE', ...item }));
      const scoped = { ...value, conversations: scope ? summaries.filter(item => item.extensionId === scope) : summaries, current: scope === extensionId ? value.current : null };
      calls.reads.push(scoped);
      return send(scoped);
    }
    if (url.pathname === '/api/authoring/turn' && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.target.extensionId).toBe(extensionId);
      expect(body.target.kind).toBe(body.conversationId ? 'resume' : 'revise');
      calls.turns.push(body);
      return onTurn ? onTurn(route, body, calls) : send({ message: 'Unexpected turn' }, 500);
    }
    if (url.pathname === '/api/authoring/recover' && method === 'POST') {
      const body = request.postDataJSON(); calls.recoveries.push(body);
      return onRecover ? onRecover(route, body, calls) : send({ message: 'Operation was not admitted' }, 404);
    }
    const conversationMatch = url.pathname.match(/^\/api\/authoring\/conversations\/([^/]+)$/);
    if (conversationMatch && method === 'GET') {
      calls.reads.push({ conversationId: conversationMatch[1] });
      if (!onRead) return send({ message: 'Unexpected conversation read' }, 404);
      return send(await onRead(calls, conversationMatch[1]));
    }
    const cancelMatch = url.pathname.match(/^\/api\/authoring\/conversations\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const body = request.postDataJSON(); calls.cancels.push({ conversationId: cancelMatch[1], body });
      return onCancel ? onCancel(route, cancelMatch[1], body, calls) : send({ message: 'Unexpected cancel' }, 500);
    }
    return send({ message: 'Unexpected authoring route' }, 404);
  });
  return calls;
}

function captureDraftVersion(page) {
  let value;
  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (/^\/api\/extensions\/[^/]+$/.test(url.pathname) && response.request().method() === 'GET') {
        const state = await response.json();
        if (state.extension?.id && Number.isSafeInteger(state.draftVersion)) value = state.draftVersion;
      }
    } catch { /* Other requests and non-JSON responses are irrelevant to the captured version. */ }
  });
  return () => value;
}

async function openSavedItem(page, extensionId) {
  const mobile = page.getByLabel('Destination', { exact: true });
  if (await mobile.isVisible()) await mobile.selectOption('customizations');
  else await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator(`#edit-${extensionId}`).click();
  await expect(studio(page)).toBeVisible();
}
async function enterStudio(page, demo, user = 'Maya') {
  await page.goto(demo.origin);
  await page.getByRole('button', { name: `Continue as ${user}` }).click();
  await page.getByRole('button', { name: user === 'Maya' ? 'Gather material references' : 'Plan the Saturday session', exact: true }).click();
  await page.locator('#open-customizations').click();
  await openSavedItem(page, demo.extensionIds[user.toLowerCase()]);
  await expect(studio(page)).toBeVisible();
  await expect(authoring(page)).toBeVisible();
  await expect(authoring(page)).not.toContainText('AI setup has not been confirmed');
}

async function prepareTask(page, demo) {
  const { source, cases } = taskCustomizationFixture();
  const { contextToken } = await (await page.request.get(`${demo.origin}/api/session`)).json();
  const headers = { origin: demo.origin, 'x-session-context': contextToken };
  const mutate = async (operation, data) => {
    const response = await page.request.post(`${demo.origin}/api/extensions/${demo.extensionIds.maya}/${operation}`, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const compiled = await mutate('compile', { hookId: TASK_HOOK, source, label: 'Actual offered task customization', draftVersion: 0 });
  const suite = await mutate('scenarios', { revisionId: compiled.draft.id, cases, draftVersion: compiled.draftVersion });
  return { source, suite, mutate };
}

async function openDetails(page) {
  const ui = studio(page);
  await ui.getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(ui.locator('.rs-tools')).toHaveJSProperty('open', true);
}

test('missing setup offers Configure and saved task source without a generation or manual fallback', async ({ page, demo }) => {
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya, availability: unavailable });
  await enterStudio(page, demo);
  const ui = studio(page), panel = authoring(page);
  await expect(panel).toContainText('Set up the assistant to create or change a customization.');
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Ask for a task customization');
  await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(ui.getByRole('button', { name: 'Configure', exact: true })).toHaveCount(1);
  const { source } = await prepareTask(page, demo);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
  await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
  await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText(source);
  await openDetails(page);
  await expect(ui.getByLabel('Developer qualification')).toHaveCount(0);
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
  await expect(ui.getByRole('button', { name: /for open tasks$/ })).toHaveCount(0);
  expect(calls.turns).toHaveLength(0);
});

for (const width of [1440, 390]) test(`turns keep exact versions and stable server messages do not duplicate across polling (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const getDraftVersion = captureDraftVersion(page);
  let firstPolls = 0, secondPolls = 0;
  let current;
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onTurn: async (route, body) => {
      const runId = `run-${calls.turns.length}`;
      const userMessage = message(`user-${calls.turns.length}`, 'user', body.text);
      const messages = [...(current?.messages ?? []), userMessage];
      current = conversation(demo.extensionIds.maya, body.conversationId ?? 'conversation-1', body.expectedVersion + 1, 'RUNNING', messages,
        { runId, draftVersion: body.expectedDraftVersion });
      current.operation = { id: body.operationId, runId, version: body.expectedVersion + 1 };
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operation: current.operation, conversation: current }) });
    },
    onRead: async (_calls, id) => {
      if (!id) return { availability: available, conversations: [], current: null };
      if (current.id !== id) return { message: 'Unknown conversation' };
      if (current.version === 1) {
        if (current.status === 'RUNNING') {
          firstPolls++;
          const stable = message('progress-1', 'assistant', 'Checking the submitted task customization request.');
          if (firstPolls < 2) current = { ...current, messages: [...current.messages, stable] };
          else current = conversation(demo.extensionIds.maya, current.id, 1, 'AWAITING_USER', [...current.messages, message('clarify-1', 'assistant', 'Which project should this customization cover?', 'clarification')], { runId: current.runId, operation: current.operation, draftVersion: current.draft.draftVersion });
        }
      } else {
        if (current.status === 'RUNNING') {
          secondPolls++;
          const stable = message('progress-2', 'assistant', 'Checking the follow-up request.');
          if (secondPolls < 2) current = { ...current, messages: [...current.messages, stable] };
          else current = conversation(demo.extensionIds.maya, current.id, 2, 'AWAITING_USER', [...current.messages, message('clarify-2', 'assistant', 'What should the next example cover?', 'clarification')], { runId: current.runId, operation: current.operation, draftVersion: current.draft.draftVersion });
        }
      }
      return current;
    },
  });
  await enterStudio(page, demo);
  await expect.poll(getDraftVersion).toBe(0);
  const ui = studio(page);
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Suggest a task customization for my projects');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('Which project should this customization cover?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Object.keys(calls.turns[0]).sort()).toEqual(['conversationId', 'expectedDraftVersion', 'expectedVersion', 'operationId', 'target', 'text']);
  expect(calls.turns[0]).toMatchObject({ conversationId: null, text: 'Suggest a task customization for my projects', expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'revise', extensionId: demo.extensionIds.maya, baseRevisionId: null, selectionGeneration: 0 } });
  expect(typeof calls.turns[0].operationId).toBe('string');
  expect(await ui.getByText('Checking the submitted task customization request.', { exact: true }).count()).toBe(1);
  expect(firstPolls).toBeGreaterThanOrEqual(2);

  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Use open tasks as the first example');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('What should the next example cover?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Object.keys(calls.turns[1]).sort()).toEqual(['conversationId', 'expectedDraftVersion', 'expectedVersion', 'operationId', 'target', 'text']);
  expect(calls.turns[1]).toMatchObject({ conversationId: 'conversation-1', text: 'Use open tasks as the first example', expectedVersion: 1, expectedDraftVersion: 0, target: { kind: 'resume', extensionId: demo.extensionIds.maya } });
  expect(typeof calls.turns[1].operationId).toBe('string');
  expect(calls.turns[1].operationId).not.toBe(calls.turns[0].operationId);
  expect(await ui.getByText('Checking the follow-up request.', { exact: true }).count()).toBe(1);
  expect(secondPolls).toBeGreaterThanOrEqual(1);
  expect(new URL(page.url()).hash).toBe('#customization=' + demo.extensionIds.maya);
});

for (const width of [1440, 390]) test(`lost accepted turn response is read back without automatic repost (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  let accepted, posted;
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onTurn: async (route, body) => {
      posted = body;
      accepted = conversation(demo.extensionIds.maya, 'accepted-conversation', body.expectedVersion + 1, 'AWAITING_USER', [
        message('accepted-user', 'user', body.text), message('accepted-answer', 'assistant', 'The request was saved. What should I clarify?', 'clarification'),
      ], { runId: 'accepted-run', operation: { id: body.operationId, runId: 'accepted-run', version: body.expectedVersion + 1 }, draftVersion: body.expectedDraftVersion });
      return route.abort('failed');
    },
    onRecover: (route, body) => {
      expect(body).toEqual(posted);
      return route.fulfill({ status: 200, json: { operation: accepted.operation, conversation: accepted } });
    },
    onRead: async (_calls, id) => id
      ? accepted
      : !accepted ? { availability: available, conversations: [], current: null }
      : { availability: available, conversations: [{ id: accepted.id, version: accepted.version, status: accepted.status,
        runId: accepted.runId, creationOperationId: posted.operationId, operationId: accepted.operation.id }], current: null },
  });
  await enterStudio(page, demo);
  const ui = studio(page);
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Tell me what task fields are available');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('The request was saved. What should I clarify?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(calls.turns).toHaveLength(1);
  expect(calls.recoveries).toEqual([posted]);
  await expect.poll(() => calls.turns.length).toBe(1);
});

for (const width of [1440, 683]) test(`Stop stays visible and remains cancelling until settled readback (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 683 ? 384 : 1000 });
  let current, settled = false, cancelRequest;
  let releaseCancelledStatus, markCancelledStatusStarted;
  const cancelledStatusStarted = new Promise(resolve => { markCancelledStatusStarted = resolve; });
  const lifecycleActions = [];
  page.on('request', request => {
    if (/\/api\/extensions\/[^/]+\/(approve|activate)$/.test(new URL(request.url()).pathname)) lifecycleActions.push(request.url());
  });
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onTurn: async (route, body) => {
      current = conversation(demo.extensionIds.maya, 'stoppable', 1, 'RUNNING', [message('turn-user', 'user', body.text)], { runId: 'run-stoppable', draftVersion: body.expectedDraftVersion });
      current.operation = { id: body.operationId, runId: 'run-stoppable', version: 1 };
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operation: current.operation, conversation: current }) });
    },
    onRead: async (_calls, id) => {
      if (!id) return { availability: available, conversations: [], current: null };
      if (current.status === 'CANCELLING' && !settled) {
        markCancelledStatusStarted();
        await new Promise(resolve => { releaseCancelledStatus = resolve; });
      }
      return current;
    },
    onCancel: async (route, id, body) => {
      cancelRequest = { id, body };
      current = { ...current, status: 'CANCELLING' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
    },
  });
  await enterStudio(page, demo);
  const panel = authoring(page);
  await studio(page).getByLabel('Message to Daymark assistant', { exact: true }).fill('Start a bounded authoring request');
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
  await studio(page).getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep this unsent follow-up');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await cancelledStatusStarted;
  await expect(panel.getByRole('status').filter({ hasText: 'Stopping; waiting for accepted work to settle' })).toBeVisible();
  expect(cancelRequest).toEqual({ id: 'stoppable', body: { runId: 'run-stoppable', expectedVersion: 1 } });
  await expect(panel.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Stopping…', exact: true })).toBeInViewport();
  await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep this unsent follow-up');

  current = { ...current, status: 'CANCELLED' };
  settled = true;
  releaseCancelledStatus();
  await expect(panel.getByRole('status').filter({ hasText: 'Authoring stopped' })).toBeVisible({ timeout: 10_000 });
  await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep this unsent follow-up');
  expect(lifecycleActions).toEqual([]);
  expect(calls.turns).toHaveLength(1);
  expect(calls.cancels).toHaveLength(1);
});

test('held status from an old owner cannot appear in the newly mounted Studio after owner switch', async ({ page, demo }) => {
  let releaseStatus, statusEntered, oldConversation;
  const held = new Promise(resolve => { statusEntered = resolve; });
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onTurn: async (route, body) => {
      oldConversation = conversation(demo.extensionIds.maya, 'maya-only', 1, 'RUNNING', [message('maya-user', 'user', body.text)], { runId: 'maya-run' });
      oldConversation.operation = { id: body.operationId, runId: 'maya-run', version: 1 };
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operation: oldConversation.operation, conversation: oldConversation }) });
    },
    onRead: async (_calls, id) => {
      if (!id) return { availability: available, conversations: [], current: null };
      if (id !== oldConversation.id) return { message: 'Unknown conversation' };
      statusEntered();
      await new Promise(resolve => { releaseStatus = resolve; });
      return { ...oldConversation, messages: [...oldConversation.messages, message('maya-late', 'assistant', 'Late private Maya response')] };
    },
  });
  await enterStudio(page, demo);
  const ui = studio(page);
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Private Maya request');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await held;

  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.locator('#open-customizations').click();
  await openSavedItem(page, demo.extensionIds.leo);
  await expect(authoring(page)).toBeVisible();
  await expect(authoring(page)).not.toContainText('AI setup has not been confirmed');
  releaseStatus();
  await expect(studio(page).getByText('Late private Maya response', { exact: true })).toHaveCount(0);
  await expect(studio(page).getByText('Private Maya request', { exact: true })).toHaveCount(0);
  await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(1);
});

test('mount, reload and readback never submit; saved messages reappear from GET state', async ({ page, demo }) => {
  const saved = conversation(demo.extensionIds.maya, 'saved-conversation', 4, 'AWAITING_USER', [
    message('saved-user', 'user', 'Please keep this conversation'), message('saved-assistant', 'assistant', 'This message came from saved state.', 'clarification'),
  ]);
  let getCount = 0;
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onRead: async (_calls, id) => {
      if (id) return saved;
      getCount++;
      return { availability: available, conversations: [{ id: saved.id, version: saved.version, status: saved.status,
        runId: saved.runId, creationOperationId: 'creation-saved', operationId: saved.operation.id }], current: saved };
    },
    onTurn: async route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'No turn is expected in this test' }) }),
  });
  await enterStudio(page, demo);
  const panel = authoring(page);
  await expect(studio(page).getByText('This message came from saved state.', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(0);
  await page.reload();
  await expect(studio(page)).toBeVisible();
  await expect(studio(page).getByText('This message came from saved state.', { exact: true })).toBeVisible();
  await openDetails(page);
  await authoring(page).getByRole('button', { name: 'Check authoring status', exact: true }).click();
  await expect(authoring(page).getByRole('button', { name: 'Continue current changes in a new conversation', exact: true })).toHaveCount(0);
  await expect(studio(page).getByLabel('Message to Daymark assistant', { exact: true })).toBeVisible();
  expect(getCount).toBeGreaterThan(1);
  expect(calls.turns).toHaveLength(0);
});

for (const [eligible, width] of [[false, 1440], [true, 1440], [true, 683]]) test(`an offered review preserves its actual evidence and host eligibility (${eligible}, ${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 683 ? 384 : 1000 });
  await page.goto(demo.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const { contextToken } = await (await page.request.get(`${demo.origin}/api/session`)).json();
  const { source, suite, mutate: lifecycle } = await prepareTask(page, demo);
  const first = await lifecycle('simulate', { revisionId: suite.draft.id, draftVersion: suite.draftVersion });
  const latest = await lifecycle('simulate', { revisionId: suite.draft.id, draftVersion: suite.draftVersion });
  expect(first.evidence.passed).toBe(true); expect(latest.evidence.passed).toBe(true);
  expect(first.evidence.id).not.toBe(latest.evidence.id);
  const offered = conversation(demo.extensionIds.maya, 'offered-conversation', 1, 'REVIEW_AVAILABLE', [message('offer', 'assistant', 'Inspect the exact offered run.', 'review')], {
    draftVersion: suite.draftVersion, review: { revisionId: suite.draft.id, draftVersion: suite.draftVersion,
      suiteDigest: suite.draft.suiteDigest, evidenceId: first.evidence.id, eligible },
  });
  offered.draft = { revisionId: suite.draft.id, draftVersion: suite.draftVersion, suiteDigest: suite.draft.suiteDigest };
  let presented = width === 683 ? { ...offered, status: 'RUNNING', review: null, messages: [] } : offered;
  await scriptAuthoring(page, { extensionId: demo.extensionIds.maya, onRead: async (_calls, id) => {
    if (id) { presented = offered; return offered; }
    return { availability: available, conversations: [{ id: offered.id, version: 1, status: presented.status, runId: offered.runId,
      creationOperationId: 'offered-creation', operationId: offered.operation.id }], current: presented };
  } });
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.locator('#open-customizations').click();
  await openSavedItem(page, demo.extensionIds.maya);
  const ui = studio(page);
  await expect(ui.getByText('Inspect the exact offered run.', { exact: true })).toBeVisible();
  const heading = ui.locator('.rs-chat-note');
  await expect(heading).toContainText('Messages use your configured assistant');
  await expect(heading).not.toContainText(available.provider);
  await expect(heading).not.toContainText(available.model);
  const offerButton = authoring(page).getByRole('button', { name: eligible ? 'View saved changes' : 'View earlier examples', exact: true }).first();
  await expect(offerButton).toBeInViewport();
  await expect(offerButton).toBeEnabled();
  if (width === 683) {
    await ui.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await openSavedItem(page, demo.extensionIds.maya);
    await expect(offerButton).toBeInViewport();
    await expect(offerButton).toBeEnabled();
  }
  await openDetails(page);
  const disclosure = ui.getByRole('region', { name: 'Assistant connection details', exact: true });
  await expect(disclosure).toContainText(`Provider: ${available.provider}`);
  await expect(disclosure).toContainText(`Model: ${available.model}`);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep this unsent conversation draft');
  const requested = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (/^\/api\/extensions\/[^/]+\/evidence\//.test(path)) requested.push(path.split('/').at(-1)); });
  await offerButton.click();
  await expect(ui.getByRole('heading', { name: eligible ? 'Simulation' : 'Earlier examples', exact: true })).toBeVisible();
  expect(requested).toEqual([first.evidence.id]);
  expect((await (await page.request.get(demo.origin + '/api/extensions/' + demo.extensionIds.maya, { headers: { 'x-session-context': contextToken } })).json()).approved).toBe(false);
  if (eligible) {
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await ui.getByText('Exact saved change and checks', { exact: true }).click();
    const savedSource = ui.getByLabel('Saved source for approval', { exact: true });
    await expect(savedSource).toBeVisible(); expect(await savedSource.textContent()).toBe(source);
    await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toBeEnabled();
    const state = await (await page.request.get(demo.origin + '/api/extensions/' + demo.extensionIds.maya, { headers: { 'x-session-context': contextToken } })).json();
    expect(state.approvedEvidenceId).toBe(first.evidence.id);
    expect(state.evidence.id).toBe(latest.evidence.id); expect(state.selection).toEqual(latest.selection);
  } else {
    await ui.locator('.rs-example-details > summary').click();
    await expect(ui.getByText(/Earlier run for current proposal/)).toBeVisible();
    await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await openSavedChanges(page);
    const currentDecision = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(currentDecision).toBeVisible();
    await currentDecision.getByText('Exact saved change and checks', { exact: true }).click();
    await expect(currentDecision).toContainText('Evidence: ' + latest.evidence.id);
    expect((await (await page.request.get(demo.origin + '/api/extensions/' + demo.extensionIds.maya, { headers: { 'x-session-context': contextToken } })).json()).approvedEvidenceId).toBe(null);
  }
  await expect(ui.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep this unsent conversation draft');
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
});

test('active observation pauses while hidden and keeps reading beyond 130 without starting work', async ({ page, demo }) => {
  test.setTimeout(60_000);
  await page.clock.install();
  let reads = 0;
  const current = conversation(demo.extensionIds.maya, 'bounded-observation', 1, 'RUNNING', [message('observed', 'assistant', 'Observed 0')]);
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya, onRead: async (_calls, id) => {
    if (!id) return { availability: available, conversations: [{ id: current.id, version: 1, status: current.status,
      runId: current.runId, creationOperationId: 'bounded-creation', operationId: current.operation.id }], current };
    reads++;
    current.messages = [message('observed', 'assistant', `Observed ${reads}`)];
    return current;
  } });
  await enterStudio(page, demo);
  await expect(studio(page).getByText('Observed 0', { exact: true })).toBeVisible();
  await page.clock.runFor(500);
  expect(reads).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5000);
  expect(reads).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let count = 1; count <= 135; count++) {
    await page.clock.runFor(1000);
    await expect(studio(page).getByText(`Observed ${count}`, { exact: true })).toBeVisible();
  }
  expect(reads).toBe(135);
  await expect(authoring(page)).not.toContainText('Automatic observation reached its limit');
  expect(calls.turns).toHaveLength(0);
  expect(calls.cancels).toHaveLength(0);
});

test('failed start and failed recovery block retry until readback, then reuse the exact submitted operation', async ({ page, demo }) => {
  let failRead = true, releaseRead, readEntered, dispatches = 0;
  const entered = new Promise(resolve => { readEntered = resolve; });
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya, onTurn: async (route, body, recorded) => {
    if (recorded.turns.length === 1) return route.abort('failed');
    dispatches++;
    const current = conversation(demo.extensionIds.maya, 'retried-once', 1, 'AWAITING_USER', [message('answer', 'assistant', 'The same request was accepted once.', 'clarification')],
      { operation: { id: body.operationId, runId: 'run-retried-once', version: 1 } });
    return route.fulfill({ status: 202, json: { operation: current.operation, conversation: current } });
  }, onRecover: async route => {
    if (!failRead) return route.fulfill({ status: 404, json: { message: 'Operation was not admitted' } });
    failRead = false; readEntered();
    await new Promise(resolve => { releaseRead = resolve; });
    await route.fulfill({ status: 503, json: { message: 'Readback temporarily unavailable' } }).catch(() => {});
  } });
  try {
    await enterStudio(page, demo);
    const ui = studio(page), panel = authoring(page);
    await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Original submitted request');
    await ui.getByRole('button', { name: 'Send', exact: true }).click(); await entered;
    await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep this new unsent follow-up');
    await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
    releaseRead();
    await expect(panel).toContainText("The submitted request's outcome could not be checked");
    expect(calls.recoveries).toEqual([calls.turns[0]]);
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Check authoring status', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toBeEnabled();
    expect(calls.recoveries).toEqual([calls.turns[0], calls.turns[0]]);
    expect(calls.turns).toHaveLength(1);
    await panel.getByRole('button', { name: 'Retry submitted request', exact: true }).click();
    await expect(ui.getByText('The same request was accepted once.', { exact: true })).toBeVisible();
    expect(calls.turns).toHaveLength(2);
    expect(calls.turns[1]).toEqual(calls.turns[0]);
    expect(dispatches).toBe(1);
    await expect(ui.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep this new unsent follow-up');
  } finally { releaseRead?.(); }
});

test('saved lifecycle receipts preserve the complete loaded conversation when AI configuration is unavailable', async ({ page, demo }) => {
  const saved = conversation(demo.extensionIds.maya, 'retained-history', 1, 'AWAITING_USER', Array.from({ length: 42 }, (_, index) =>
    message(`saved-${index}`, 'assistant', `Saved conversation message ${index}`)));
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya, onRead: async (_calls, id) => id ? saved : { availability: unavailable,
    conversations: [{ id: saved.id, version: saved.version, status: saved.status, runId: saved.runId,
      creationOperationId: 'history-creation', operationId: saved.operation.id }], current: saved } });
  await enterStudio(page, demo);
  const ui = studio(page);
  await expect(ui.getByText(/^Saved conversation message /)).toHaveCount(42);
  const { suite: draft, mutate } = await prepareTask(page, demo);
  await openDetails(page);
  await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
  const proof = await mutate('simulate', { revisionId: draft.revisionId, draftVersion: draft.draftVersion });
  expect(proof.evidence.passed).toBe(true);
  await ui.getByRole('button', { name: 'Reload saved state', exact: true }).click();
  await expect(ui.getByText(/^Saved conversation message /)).toHaveCount(42);
  expect(calls.turns).toHaveLength(0);
});

for (const code of ['SPEND_LIMIT', 'BUDGET_EXHAUSTED', 'PROVIDER_RATE_LIMIT', 'CONTEXT_LIMIT', 'EXPIRED']) test(`saved ${code} recovery continues only explicitly in the same discussion`, async ({ page, demo }) => {
  let current = { ...conversation(demo.extensionIds.maya, 'saved-discussion', 4, 'BLOCKED', [
    message('saved-user', 'user', 'Keep my task completion changes. ' + '🧭אב'.repeat(3000)),
    message('saved-answer', 'assistant', 'The saved examples still describe your request.'),
  ]), code };
  const calls = await scriptAuthoring(page, { extensionId: demo.extensionIds.maya,
    onRead: async (_calls, id) => id ? current : { availability: available, conversations: [{ id: current.id, version: current.version,
      status: current.status, runId: current.runId, creationOperationId: 'saved-creation', operationId: current.operation.id }], current },
    onTurn: async (route, body) => {
      current = conversation(demo.extensionIds.maya, current.id, body.expectedVersion + 1, 'AWAITING_USER', [...current.messages,
        message('continued-user', 'user', body.text), message('continued', 'assistant', 'Ready for your next choice.', 'clarification')],
        { operation: { id: body.operationId, runId: 'continued-run', version: body.expectedVersion + 1 }, runId: 'continued-run', draftVersion: body.expectedDraftVersion });
      return route.fulfill({ status: 202, json: { operation: current.operation, conversation: current } });
    },
  });
  await enterStudio(page, demo);
  const ui = studio(page), composer = ui.getByLabel('Message to Daymark assistant', { exact: true });
  await composer.fill('Keep this unsent follow-up');
  const continuation = ui.getByRole('button', { name: code === 'PROVIDER_RATE_LIMIT' ? 'Try again from saved work' : 'Continue here from saved work', exact: true });
  expect(calls.turns).toHaveLength(0);
  if (code === 'SPEND_LIMIT') {
    await expect(ui).toContainText('The shared authoring allowance is exhausted.');
    await expect(continuation).toHaveCount(0);
    return;
  }
  if (code === 'BUDGET_EXHAUSTED') await expect(ui).toContainText('An earlier authoring policy stopped this saved run.');
  if (code === 'CONTEXT_LIMIT') await expect(ui).toContainText('This run reached the assistant’s request size boundary.');
  await expect(continuation).toBeEnabled();
  await continuation.click();
  await expect(ui.getByText('Ready for your next choice.', { exact: true })).toBeVisible();
  expect(calls.turns).toEqual([{ conversationId: 'saved-discussion', operationId: expect.any(String), expectedVersion: 4,
    expectedDraftVersion: 0, target: { kind: 'resume', extensionId: demo.extensionIds.maya },
    text: 'Continue from saved work. Ask before changing any independent examples.' }]);
  await expect(composer).toHaveValue('Keep this unsent follow-up');
  await expect(ui.locator('.rs-yours').first()).toContainText('Keep my task completion changes.');
  await expect(continuation).toHaveCount(0);
  await page.reload();
  await expect(ui.getByText('Ready for your next choice.', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(1);
  expect(calls.cancels).toHaveLength(0);
});
