import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

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
      await use({ origin: server.origin });
    } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});

const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
const authoring = page => studio(page).getByRole('region', { name: 'AI authoring', exact: true });
const available = { available: true, code: null, provider: 'openai', model: 'test-model' };
const unavailable = { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null };

function conversation(id, version, status, messages, { runId = `run-${id}`, operation, draftVersion = 0, review = null } = {}) {
  return { id, version, status, runId, operation: operation ?? { id: `operation-${id}`, runId, version },
    messages, code: null, review, draft: { revisionId: null, draftVersion, suiteDigest: null },
    selection: { revisionId: null, generation: 1 } };
}

function message(id, role, text, kind = 'text') { return { id, role, text, kind }; }

async function scriptAuthoring(page, { availability = available, onTurn, onRead, onCancel } = {}) {
  const calls = { turns: [], reads: [], cancels: [] };
  await page.route('**/api/authoring**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = async (body, status = 200) => {
      try { return await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
      catch (error) { if (request.failure()) return; throw error; }
    };
    if (url.pathname === '/api/authoring' && method === 'GET') {
      const value = onRead ? await onRead(calls) : { availability, conversations: [], current: null };
      calls.reads.push(value);
      return send(value);
    }
    if (url.pathname === '/api/authoring/turn' && method === 'POST') {
      const body = request.postDataJSON(); calls.turns.push(body);
      return onTurn ? onTurn(route, body, calls) : send({ message: 'Unexpected turn' }, 500);
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
      if (url.pathname === '/api/extensions' && response.request().method() === 'GET')
        value = (await response.json()).draftVersion;
    } catch { /* Other requests and non-JSON responses are irrelevant to the captured version. */ }
  });
  return () => value;
}

async function enterStudio(page, origin, user = 'Maya') {
  await page.goto(origin);
  await page.getByRole('button', { name: `Continue as ${user}` }).click();
  await page.getByRole('button', { name: user === 'Maya' ? 'Gather material references' : 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page)).toBeVisible();
  await expect(authoring(page)).toBeVisible();
  await expect(authoring(page)).not.toContainText('AI setup has not been confirmed');
}

async function openDetails(page) {
  const ui = studio(page);
  if (await ui.locator('.rs-preview').isHidden()) {
    await ui.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(ui.locator('.rs-tools')).toHaveJSProperty('open', true);
    return;
  }
  const summary = ui.locator('details.rs-tools:not([open]) > summary');
  if (await summary.count()) await summary.click();
}

test('unavailable provider leaves prepared and manual tools usable without creating a job', async ({ page, demo }) => {
  const calls = await scriptAuthoring(page, { availability: unavailable });
  await enterStudio(page, demo.origin);
  const ui = studio(page), panel = authoring(page);
  await expect(panel).toContainText('AI authoring is not configured for use');
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Ask for a read-only task suggestion');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('AI authoring is unavailable. Choose prepared advice, review a saved proposal, or open Developer qualification under Manage to enter read-only source and independent examples. No task has changed.', { exact: true })).toBeVisible();

  await ui.getByRole('button', { name: 'Needs attention for open tasks', exact: true }).click();
  const proposal = ui.getByRole('button', { name: 'View proposal', exact: true });
  if (await proposal.count() && await proposal.isVisible()) await proposal.click();
  await expect(ui.getByRole('article', { name: 'Proposed advice' })).toBeVisible();
  await openDetails(page);
  const manual = studio(page).locator('.rs-developer');
  if (!await manual.evaluate(node => node.open)) await manual.locator(':scope > summary').click();
  await expect(manual.getByLabel('Keir source (developer)', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(0);
});

for (const width of [1440, 390]) test(`turns keep exact versions and stable server messages do not duplicate across polling (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const getDraftVersion = captureDraftVersion(page);
  let firstPolls = 0, secondPolls = 0;
  let current;
  const calls = await scriptAuthoring(page, {
    onTurn: async (route, body) => {
      const runId = `run-${calls.turns.length}`;
      const userMessage = message(`user-${calls.turns.length}`, 'user', body.text);
      const messages = [...(current?.messages ?? []), userMessage];
      current = conversation(body.conversationId ?? 'conversation-1', body.expectedVersion + 1, 'RUNNING', messages,
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
          const stable = message('progress-1', 'assistant', 'Checking the submitted advice request.');
          if (firstPolls < 2) current = { ...current, messages: [...current.messages, stable] };
          else current = conversation(current.id, 1, 'AWAITING_USER', [...current.messages, message('clarify-1', 'assistant', 'Which task should this advice cover?', 'clarification')], { runId: current.runId, operation: current.operation, draftVersion: current.draft.draftVersion });
        }
      } else {
        if (current.status === 'RUNNING') {
          secondPolls++;
          const stable = message('progress-2', 'assistant', 'Checking the follow-up request.');
          if (secondPolls < 2) current = { ...current, messages: [...current.messages, stable] };
          else current = conversation(current.id, 2, 'AWAITING_USER', [...current.messages, message('clarify-2', 'assistant', 'What should the next example cover?', 'clarification')], { runId: current.runId, operation: current.operation, draftVersion: current.draft.draftVersion });
        }
      }
      return current;
    },
  });
  await enterStudio(page, demo.origin);
  await expect.poll(getDraftVersion).toBe(0);
  const ui = studio(page);
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Suggest read-only advice for my tasks');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('Which task should this advice cover?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Object.keys(calls.turns[0]).sort()).toEqual(['conversationId', 'expectedDraftVersion', 'expectedVersion', 'operationId', 'text']);
  expect(calls.turns[0]).toMatchObject({ conversationId: null, text: 'Suggest read-only advice for my tasks', expectedVersion: 0, expectedDraftVersion: 0 });
  expect(typeof calls.turns[0].operationId).toBe('string');
  expect(await ui.getByText('Checking the submitted advice request.', { exact: true }).count()).toBe(1);
  expect(firstPolls).toBeGreaterThanOrEqual(2);

  await ui.getByLabel('Message to Studio', { exact: true }).fill('Use open tasks as the first example');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('What should the next example cover?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Object.keys(calls.turns[1]).sort()).toEqual(['conversationId', 'expectedDraftVersion', 'expectedVersion', 'operationId', 'text']);
  expect(calls.turns[1]).toMatchObject({ conversationId: 'conversation-1', text: 'Use open tasks as the first example', expectedVersion: 1, expectedDraftVersion: 0 });
  expect(typeof calls.turns[1].operationId).toBe('string');
  expect(calls.turns[1].operationId).not.toBe(calls.turns[0].operationId);
  expect(await ui.getByText('Checking the follow-up request.', { exact: true }).count()).toBe(1);
  expect(secondPolls).toBeGreaterThanOrEqual(1);
  expect(page.url()).toBe(demo.origin + '/');
});

for (const width of [1440, 390]) test(`lost accepted turn response is read back without automatic repost (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  let accepted, posted;
  const calls = await scriptAuthoring(page, {
    onTurn: async (route, body) => {
      posted = body;
      accepted = conversation('accepted-conversation', body.expectedVersion + 1, 'AWAITING_USER', [
        message('accepted-user', 'user', body.text), message('accepted-answer', 'assistant', 'The request was saved. What should I clarify?', 'clarification'),
      ], { runId: 'accepted-run', operation: { id: body.operationId, runId: 'accepted-run', version: body.expectedVersion + 1 }, draftVersion: body.expectedDraftVersion });
      return route.abort('failed');
    },
    onRead: async (_calls, id) => id
      ? accepted
      : !accepted ? { availability: available, conversations: [], current: null }
      : { availability: available, conversations: [{ id: accepted.id, version: accepted.version, status: accepted.status,
        runId: accepted.runId, creationOperationId: posted.operationId, operationId: accepted.operation.id }], current: null },
  });
  await enterStudio(page, demo.origin);
  const ui = studio(page);
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Tell me what task fields are available');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('The request was saved. What should I clarify?', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(calls.turns).toHaveLength(1);
  expect(calls.reads.some(read => read.conversationId === accepted.id)).toBe(true);
  await expect.poll(() => calls.turns.length).toBe(1);
});

for (const width of [1440, 683]) test(`Stop stays visible and remains cancelling until settled readback (${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 683 ? 384 : 1000 });
  let current, settled = false, cancelRequest;
  let releaseCancelledStatus, markCancelledStatusStarted;
  const cancelledStatusStarted = new Promise(resolve => { markCancelledStatusStarted = resolve; });
  const lifecycleActions = [];
  page.on('request', request => {
    if (/\/api\/extensions\/(approve|activate)$/.test(new URL(request.url()).pathname)) lifecycleActions.push(request.url());
  });
  const calls = await scriptAuthoring(page, {
    onTurn: async (route, body) => {
      current = conversation('stoppable', 1, 'RUNNING', [message('turn-user', 'user', body.text)], { runId: 'run-stoppable', draftVersion: body.expectedDraftVersion });
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
  await enterStudio(page, demo.origin);
  const panel = authoring(page);
  await studio(page).getByLabel('Message to Studio', { exact: true }).fill('Start a bounded authoring request');
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
  await studio(page).getByLabel('Message to Studio', { exact: true }).fill('Keep this unsent follow-up');
  await expect(panel.getByRole('button', { name: 'Stop authoring', exact: true })).toBeInViewport();
  await panel.getByRole('button', { name: 'Stop authoring', exact: true }).click();
  await cancelledStatusStarted;
  await expect(panel.getByRole('status')).toContainText('Stopping authoring; waiting for work to settle');
  expect(cancelRequest).toEqual({ id: 'stoppable', body: { runId: 'run-stoppable', expectedVersion: 1 } });
  await expect(panel.getByRole('button', { name: 'Stopping authoring…', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Stopping authoring…', exact: true })).toBeInViewport();
  await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toHaveValue('Keep this unsent follow-up');

  current = { ...current, status: 'CANCELLED' };
  settled = true;
  releaseCancelledStatus();
  await expect(panel.getByRole('status')).toContainText('Authoring stopped', { timeout: 10_000 });
  await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toHaveValue('Keep this unsent follow-up');
  expect(lifecycleActions).toEqual([]);
  expect(calls.turns).toHaveLength(1);
  expect(calls.cancels).toHaveLength(1);
});

test('held status from an old owner cannot appear in the newly mounted Studio after owner switch', async ({ page, demo }) => {
  let releaseStatus, statusEntered, oldConversation;
  const held = new Promise(resolve => { statusEntered = resolve; });
  const calls = await scriptAuthoring(page, {
    onTurn: async (route, body) => {
      oldConversation = conversation('maya-only', 1, 'RUNNING', [message('maya-user', 'user', body.text)], { runId: 'maya-run' });
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
  await enterStudio(page, demo.origin);
  const ui = studio(page);
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Private Maya request');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await held;

  await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('leo');
  await page.getByRole('button', { name: 'Plan the Saturday session', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(authoring(page)).toBeVisible();
  await expect(authoring(page)).not.toContainText('AI setup has not been confirmed');
  releaseStatus();
  await expect(studio(page).getByText('Late private Maya response', { exact: true })).toHaveCount(0);
  await expect(studio(page).getByText('Private Maya request', { exact: true })).toHaveCount(0);
  await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(1);
});

test('mount, reload, readback and New conversation never submit; saved messages reappear from GET state', async ({ page, demo }) => {
  const saved = conversation('saved-conversation', 4, 'AWAITING_USER', [
    message('saved-user', 'user', 'Please keep this conversation'), message('saved-assistant', 'assistant', 'This message came from saved state.', 'clarification'),
  ]);
  let getCount = 0;
  const calls = await scriptAuthoring(page, {
    onRead: async (_calls, id) => {
      if (id) return saved;
      getCount++;
      return { availability: available, conversations: [{ id: saved.id, version: saved.version, status: saved.status,
        runId: saved.runId, creationOperationId: 'creation-saved', operationId: saved.operation.id }], current: saved };
    },
    onTurn: async route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'No turn is expected in this test' }) }),
  });
  await enterStudio(page, demo.origin);
  const panel = authoring(page);
  await expect(studio(page).getByText('This message came from saved state.', { exact: true })).toBeVisible();
  expect(calls.turns).toHaveLength(0);
  await page.reload();
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  await expect(studio(page).getByText('This message came from saved state.', { exact: true })).toBeVisible();
  await authoring(page).getByRole('button', { name: 'Check authoring status', exact: true }).click();
  await authoring(page).getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(studio(page).getByLabel('Message to Studio', { exact: true })).toBeVisible();
  expect(getCount).toBeGreaterThan(1);
  expect(calls.turns).toHaveLength(0);
});

for (const [eligible, width] of [[false, 1440], [true, 1440], [true, 683]]) test(`an offered review preserves its actual evidence and host eligibility (${eligible}, ${width}px)`, async ({ page, demo }) => {
  await page.setViewportSize({ width, height: width === 683 ? 384 : 1000 });
  const guide = readFileSync(new URL('../../docs/authored-extension-drafts.md', import.meta.url), 'utf8');
  const source = guide.match(/```yaml\r?\n([\s\S]*?)\r?\n```/)[1];
  const example = guide.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1];
  await page.goto(demo.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const { contextToken } = await (await page.request.get(`${demo.origin}/api/session`)).json();
  async function lifecycle(operation, body) {
    const response = await page.request.post(`${demo.origin}/api/extensions/${operation}`, {
      headers: { origin: demo.origin, 'x-session-context': contextToken }, data: body,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const compiled = await lifecycle('compile', { source, label: 'Actual offered advice', draftVersion: 0 });
  const suite = await lifecycle('scenarios', { revisionId: compiled.draft.id, cases: [example], draftVersion: compiled.draftVersion });
  const first = await lifecycle('simulate', { revisionId: suite.draft.id, draftVersion: suite.draftVersion });
  const latest = await lifecycle('simulate', { revisionId: suite.draft.id, draftVersion: suite.draftVersion });
  expect(first.evidence.passed).toBe(true); expect(latest.evidence.passed).toBe(true);
  expect(first.evidence.id).not.toBe(latest.evidence.id);
  const offered = conversation('offered-conversation', 1, 'REVIEW_AVAILABLE', [message('offer', 'assistant', 'Inspect the exact offered run.', 'review')], {
    draftVersion: suite.draftVersion, review: { revisionId: suite.draft.id, draftVersion: suite.draftVersion,
      suiteDigest: suite.draft.suiteDigest, evidenceId: first.evidence.id, eligible },
  });
  offered.draft = { revisionId: suite.draft.id, draftVersion: suite.draftVersion, suiteDigest: suite.draft.suiteDigest };
  let presented = width === 683 ? { ...offered, status: 'RUNNING', review: null, messages: [] } : offered;
  await scriptAuthoring(page, { onRead: async (_calls, id) => {
    if (id) { presented = offered; return offered; }
    return { availability: available, conversations: [{ id: offered.id, version: 1, status: presented.status, runId: offered.runId,
      creationOperationId: 'offered-creation', operationId: offered.operation.id }], current: presented };
  } });
  await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
  await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
  const ui = studio(page);
  await expect(ui.getByText('Inspect the exact offered run.', { exact: true })).toBeVisible();
  const heading = authoring(page).locator('.rs-authoring-heading');
  await expect(heading).toContainText('Assistant connected');
  await expect(heading).not.toContainText(available.provider);
  await expect(heading).not.toContainText(available.model);
  const offerButton = authoring(page).getByRole('button', { name: 'Open offered sample results', exact: true });
  await expect(offerButton).toBeInViewport();
  await expect(offerButton).toBeEnabled();
  if (width === 683) {
    await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
    await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
    await expect(offerButton).toBeInViewport();
    await expect(offerButton).toBeEnabled();
  }
  await authoring(page).getByRole('button', { name: 'Details', exact: true }).click();
  const disclosure = ui.getByRole('region', { name: 'Assistant connection details', exact: true });
  await expect(disclosure).toContainText(`Provider: ${available.provider}`);
  await expect(disclosure).toContainText(`Model: ${available.model}`);
  await openDetails(page);
  await ui.locator('.rs-developer > summary').click();
  await ui.getByLabel('Keir source (developer)', { exact: true }).fill('Keep this unsaved source buffer');
  await ui.getByLabel('Example 1 JSON', { exact: true }).fill('Keep this unsaved example buffer');
  if (width === 683) await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  const requested = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/extensions/evidence/')) requested.push(path.split('/').at(-1)); });
  await authoring(page).getByRole('button', { name: 'Open offered sample results', exact: true }).click();
  await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
  expect(requested).toEqual([first.evidence.id]);
  await expect(ui.getByRole('button', { name: 'Approve this advice', exact: true })).toHaveCount(0);
  if (eligible) {
    await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeEnabled();
    await ui.getByRole('button', { name: 'Review this advice', exact: true }).click();
    const savedSource = ui.getByLabel('Saved source for approval', { exact: true });
    await expect(savedSource).toBeVisible();
    expect(await savedSource.textContent()).toBe(source);
    await ui.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
    await ui.getByRole('button', { name: 'Approve this advice', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Use this advice for me', exact: true })).toBeEnabled();
    const state = await (await page.request.get(`${demo.origin}/api/extensions`, { headers: { 'x-session-context': contextToken } })).json();
    expect(state.approvedEvidenceId).toBe(first.evidence.id);
    expect(state.evidence.id).toBe(latest.evidence.id);
    expect(state.selection).toEqual(latest.selection);
  } else {
    await expect(ui.getByText(/Earlier run for current proposal/)).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Review this advice', exact: true })).toBeDisabled();
  }
  await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveValue('Keep this unsaved source buffer');
  await expect(ui.getByLabel('Example 1 JSON', { exact: true })).toHaveValue('Keep this unsaved example buffer');
});

test('active observation pauses while hidden, stops at 130 reads and only offers read-only recovery', async ({ page, demo }) => {
  test.setTimeout(60_000);
  await page.clock.install();
  let reads = 0;
  const current = conversation('bounded-observation', 1, 'RUNNING', [message('observed', 'assistant', 'Observed 0')]);
  const calls = await scriptAuthoring(page, { onRead: async (_calls, id) => {
    if (!id) return { availability: available, conversations: [{ id: current.id, version: 1, status: current.status,
      runId: current.runId, creationOperationId: 'bounded-creation', operationId: current.operation.id }], current };
    reads++;
    current.messages = [message('observed', 'assistant', `Observed ${reads}`)];
    return current;
  } });
  await enterStudio(page, demo.origin);
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
  for (let count = 1; count <= 130; count++) {
    await page.clock.runFor(1000);
    await expect(studio(page).getByText(`Observed ${count}`, { exact: true })).toBeVisible();
  }
  await page.clock.runFor(1000);
  await expect(authoring(page)).toContainText('Automatic observation reached its limit');
  await page.clock.runFor(5000);
  expect(reads).toBe(130);
  const before = calls.reads.length;
  await authoring(page).getByRole('button', { name: 'Check authoring status', exact: true }).click();
  await expect.poll(() => calls.reads.length).toBe(before + 1);
  expect(calls.turns).toHaveLength(0);
  expect(calls.cancels).toHaveLength(0);
});

test('failed start and failed recovery block retry until readback, then reuse the exact submitted operation', async ({ page, demo }) => {
  let failedStart = false, failRead = true, releaseRead, readEntered, dispatches = 0;
  const entered = new Promise(resolve => { readEntered = resolve; });
  const calls = await scriptAuthoring(page, { onTurn: async (route, body, recorded) => {
    if (recorded.turns.length === 1) { failedStart = true; return route.abort('failed'); }
    dispatches++;
    const current = conversation('retried-once', 1, 'AWAITING_USER', [message('answer', 'assistant', 'The same request was accepted once.', 'clarification')],
      { operation: { id: body.operationId, runId: 'run-retried-once', version: 1 } });
    return route.fulfill({ status: 202, json: { operation: current.operation, conversation: current } });
  } });
  await page.route('**/api/authoring', async route => {
    if (!failedStart || !failRead) return route.fallback();
    failRead = false; readEntered();
    await new Promise(resolve => { releaseRead = resolve; });
    await route.fulfill({ status: 503, json: { message: 'Readback temporarily unavailable' } }).catch(() => {});
  });
  try {
    await enterStudio(page, demo.origin);
    const ui = studio(page), panel = authoring(page);
    await ui.getByLabel('Message to Studio', { exact: true }).fill('Original submitted request');
    await ui.getByRole('button', { name: 'Send', exact: true }).click(); await entered;
    await ui.getByLabel('Message to Studio', { exact: true }).fill('Keep this new unsent follow-up');
    await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
    releaseRead();
    await expect(panel).toContainText("The submitted request's outcome could not be checked");
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Check authoring status', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toBeEnabled();
    expect(calls.turns).toHaveLength(1);
    await panel.getByRole('button', { name: 'Retry submitted request', exact: true }).click();
    await expect(ui.getByText('The same request was accepted once.', { exact: true })).toBeVisible();
    expect(calls.turns).toHaveLength(2);
    expect(calls.turns[1]).toEqual(calls.turns[0]);
    expect(dispatches).toBe(1);
    await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue('Keep this new unsent follow-up');
  } finally { releaseRead?.(); }
});

test('manual receipts preserve the complete loaded conversation when AI configuration is unavailable', async ({ page, demo }) => {
  const saved = conversation('retained-history', 1, 'AWAITING_USER', Array.from({ length: 42 }, (_, index) =>
    message(`saved-${index}`, 'assistant', `Saved conversation message ${index}`)));
  const calls = await scriptAuthoring(page, { onRead: async (_calls, id) => id ? saved : { availability: unavailable,
    conversations: [{ id: saved.id, version: saved.version, status: saved.status, runId: saved.runId,
      creationOperationId: 'history-creation', operationId: saved.operation.id }], current: saved } });
  await enterStudio(page, demo.origin);
  const ui = studio(page);
  await expect(ui.getByText(/^Saved conversation message /)).toHaveCount(42);
  await ui.getByLabel('Message to Studio', { exact: true }).fill('Explain this saved advice');
  await ui.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ui.getByText('Explain this saved advice', { exact: true })).toBeVisible();
  await expect(ui.getByText(/^Saved conversation message /)).toHaveCount(42);
  expect(calls.turns).toHaveLength(0);
});
