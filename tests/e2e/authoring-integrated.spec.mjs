import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

// Offline native provider responses; every application/compiler/lifecycle operation is real.
const studio = page => page.getByRole('region', { name: 'Advice Studio', exact: true });
const authoring = page => studio(page).getByRole('region', { name: 'AI authoring', exact: true });
const send = async (page, text) => {
  await studio(page).getByLabel('Message to Studio', { exact: true }).fill(text);
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
};

for (const [provider, width] of [['openai', 1440], ['anthropic', 390]]) {
  test(`offline ${provider} native loop reaches real exact human review and Use (${width}px)`, async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await startAuthoringFixture({ provider, unconfigured: provider === 'openai' });
    try {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      if (provider === 'openai') {
        await page.getByRole('button', { name: 'Customizations', exact: true }).click();
        await page.getByRole('button', { name: 'New customization', exact: true }).click();
        await expect(authoring(page)).toContainText('AI authoring is not configured.');
        const setupRequests = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/authoring/setup' && request.method() === 'POST') setupRequests.push(request); });
        await studio(page).getByRole('button', { name: 'Configure', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
        const syntheticKey = 'synthetic-real-popup-key';
        await dialog.getByLabel('Service', { exact: true }).selectOption(provider);
        await dialog.getByLabel('API key', { exact: true }).fill(syntheticKey);
        await dialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('3');
        await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(authoring(page)).toContainText('Assistant configured');
        expect(setupRequests).toHaveLength(1);
        expect(fixture.requests).toEqual([]);
        const stored = JSON.parse(readFileSync(join(fixture.directory, 'ai-authoring.json'), 'utf8'));
        expect(stored).toMatchObject({ provider, model: 'gpt-5.6-terra', apiKey: syntheticKey, maxUsd: '3' });
        const projection = await page.evaluate(async () => {
          const session = await (await fetch('/api/session')).json();
          return (await fetch('/api/authoring/setup', { headers: { 'X-Session-Context': session.contextToken } })).json();
        });
        expect(projection.configuration).toMatchObject({ status: 'ready', source: 'local', provider, model: 'gpt-5.6-terra', maxUsd: '3' });
        expect(JSON.stringify(projection)).not.toContain(syntheticKey);
        expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))).not.toContain(syntheticKey);
        await page.reload();
        expect(fixture.requests).toEqual([]);
      }
      await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
      await page.getByLabel('Task title', { exact: true }).fill('Unsaved native title during offline authoring');
      await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
      const ui = studio(page), panel = authoring(page);
      await expect(panel.getByText('Assistant configured', { exact: true })).toBeVisible();
      expect(fixture.requests).toEqual([]);
      await expect(panel).not.toContainText(provider);
      const selectedA = fixture.db.prepare("SELECT revision_id,generation FROM extension_selections WHERE owner_id='maya'").get();
      await panel.getByRole('button', { name: 'Details', exact: true }).click();
      const connection = ui.getByRole('region', { name: 'Assistant connection details', exact: true });
      await expect(connection.getByText(`Provider: ${provider}`, { exact: true })).toBeVisible();
      await expect(connection.getByText(`Model: ${provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5'}`, { exact: true })).toBeVisible();
      await expect(ui.getByLabel('Keir source (developer)', { exact: true })).toHaveCount(0);
      await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();

      let turns = 0;
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/authoring/turn' && request.method() === 'POST') turns++;
      });
      if (provider === 'openai') {
        await page.route('**/api/authoring/turn', async route => {
          const response = await route.fetch();
          expect(response.status()).toBe(202);
          await route.abort('failed');
        }, { times: 1 });
      }
      await send(page, 'Offline synthetic qualification: draft read-only Pending/Done advice using independent examples.');
      await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
      expect(turns).toBe(1);
      expect(fixture.requests.map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification']);
      await send(page, 'Confirmed: OPEN means PENDING and COMPLETED means DONE. Use the independent synthetic cases.');
      await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByRole('button', { name: 'Open offered sample results', exact: true })).toBeEnabled();
      if (provider === 'openai') {
        await page.setViewportSize({ width: 683, height: 384 });
        await expect(panel.getByRole('button', { name: 'Open offered sample results', exact: true })).toBeInViewport({ ratio: 1 });
        mkdirSync(resolve('build/screens'), { recursive: true });
        await page.screenshot({ path: resolve('build/screens', 'authoring-offer-short-finished.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      expect(turns).toBe(2);
      expect(fixture.requests.map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification',
        'compile_draft', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);

      const session = await (await page.request.get(`${fixture.origin}/api/session`)).json();
      const read = async path => {
        const response = await page.request.get(`${fixture.origin}/api/${path}`, { headers: { 'x-session-context': session.contextToken } });
        expect(response.ok(), await response.text()).toBe(true); return response.json();
      };
      const conversation = (await read('authoring')).current;
      expect(conversation.status).toBe('REVIEW_AVAILABLE'); expect(conversation.review.eligible).toBe(true);
      expect(conversation.version).toBe(2); expect(conversation.draft.draftVersion).toBe(2);
      const state = await read('extensions');
      expect(state.selection.revision.id).toBe(selectedA.revision_id);
      expect(state.selection.generation).toBe(selectedA.generation); expect(state.approved).toBe(false);
      const saved = await read(`extensions/revisions/${conversation.review.revisionId}`);
      expect(saved.source).toBe(fixture.metadata.source); expect(saved.cases).toEqual(fixture.metadata.cases);
      const evidenceRequests = [];
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/extensions/evidence/')) evidenceRequests.push(path.split('/').at(-1));
      });
      await ui.getByLabel('Message to Studio', { exact: true }).fill('Keep this unsent refinement while reviewing');
      await panel.getByRole('button', { name: 'Open offered sample results', exact: true }).click();
      await expect(ui.getByRole('heading', { name: 'Sample run passed', exact: true })).toBeVisible();
      expect(evidenceRequests).toEqual([conversation.review.evidenceId]);
      await expect(ui.getByRole('cell', { name: /^Matches/ })).toHaveCount(fixture.metadata.cases.length);
      await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue('Keep this unsent refinement while reviewing');
      await ui.getByRole('article', { name: 'Sample results', exact: true }).getByRole('button', { name: 'Review this advice', exact: true }).click();
      await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(fixture.metadata.source);
      for (let index = 0; index < fixture.metadata.cases.length; index++)
        await expect(ui.getByLabel(`Saved example ${index + 1} for approval`, { exact: true })).toHaveText(fixture.metadata.cases[index]);
      await expect(ui.getByRole('button', { name: 'Approve this advice', exact: true })).toBeDisabled();
      mkdirSync(resolve('build/screens'), { recursive: true });
      await page.screenshot({ path: resolve('build/screens', `authoring-integrated-${provider}.png`), fullPage: true });
      await ui.getByLabel('I reviewed these sample results and want this advice for my tasks.').check();
      await ui.getByRole('button', { name: 'Approve this advice', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'Use this advice for me', exact: true })).toBeEnabled();
      expect((await read('extensions')).selection.revision.id).toBe(selectedA.revision_id);
      await ui.getByRole('button', { name: 'Use this advice for me', exact: true }).click();
      await expect.poll(async () => (await read('extensions')).selection.revision.id).toBe(conversation.review.revisionId);
      expect((await read('extensions')).selection.generation).toBe(selectedA.generation + 1);
      await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved native title during offline authoring');
      await page.getByRole('button', { name: 'Check task advice', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Task advice: Pending' })).toBeVisible();
      const callCount = fixture.requests.length;
      if (provider === 'openai') {
        await page.setViewportSize({ width: 683, height: 384 });
        await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Open offered sample results', exact: true })).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: resolve('build/screens', 'authoring-offer-short-reopened.png'), fullPage: true });
        expect(fixture.requests.length).toBe(callCount); expect(turns).toBe(2);
      }
      await page.reload();
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
      expect((await read('authoring')).current.review.evidenceId).toBe(conversation.review.evidenceId);
      expect((await read('extensions')).selection.revision.id).toBe(conversation.review.revisionId);
      expect(fixture.requests.length).toBe(callCount); expect(turns).toBe(2);
      if (provider === 'openai') {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
        await page.getByRole('button', { name: 'Manage task advice', exact: true }).click();
        const intended = 'Refine the saved advice after replacing assistant settings.';
        await ui.getByLabel('Message to Studio', { exact: true }).fill(intended);
        await panel.getByRole('button', { name: 'Details', exact: true }).click();
        await ui.getByRole('button', { name: 'Configure', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Set up the assistant', exact: true });
        await dialog.getByLabel('API key', { exact: true }).fill('synthetic-replacement-key');
        await dialog.getByLabel('Shared allowance (USD)', { exact: true }).fill('6');
        const held = fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
        await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue(intended);
        expect(fixture.requests.length).toBe(callCount);
        expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(held);
        await send(page, intended);
        await expect(panel.getByRole('alert')).toContainText('Start a new conversation');
        await expect(panel.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
        await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
        await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue(intended);
        await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible();
        expect((await read('authoring')).current.id).toBe(conversation.id);
        expect(fixture.requests.length).toBe(callCount); expect(turns).toBe(3);
        await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
        await send(page, intended);
        await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
        expect(fixture.requests.slice(callCount).map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification']);
        expect((await read('extensions')).selection.revision.id).toBe(conversation.review.revisionId);
        expect(turns).toBe(4);
      }
    } finally { await fixture.close(); }
  });
}
