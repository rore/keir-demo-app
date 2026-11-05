import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

// Offline native provider responses; every application/compiler/lifecycle operation is real.
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const authoring = studio;
const decision = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
function scopedPath(page, path, id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization')) {
  if (path === 'authoring') {
    expect(id, 'Authoring reads identify the intended saved customization.').toBeTruthy();
    return `authoring?extensionId=${id}`;
  }
  if (path === 'extensions' && id) return `extensions/${id}`;
  if (/^extensions\/(revisions|evidence)\//.test(path)) {
    expect(id).toBeTruthy();
    return path.replace('extensions/', `extensions/${id}/`);
  }
  return path;
}
async function navigate(page, destination) {
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const select = page.getByLabel('Destination', { exact: true });
  if (await select.isVisible()) await select.selectOption(destination.toLowerCase());
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: destination, exact: true }).click();
}
async function selectProject(page, name) {
  const select = page.getByLabel('Project', { exact: true });
  if (await select.isVisible()) await select.selectOption({ label: name });
  else await page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function addTask(page, title) {
  await page.getByLabel('New task title', { exact: true }).fill(title);
  await page.getByRole('button', { name: /^Add task/ }).click();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
}
const send = async (page, text) => {
  await studio(page).getByLabel('Message to Studio', { exact: true }).fill(text);
  await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
};
async function openDetails(page) {
  await studio(page).getByRole('button', { name: 'History and details', exact: true }).click();
  await expect(studio(page).locator('.rs-tools')).toHaveJSProperty('open', true);
}

test('offline semantic mismatch stays visible and unapproved until an explicit source correction passes the same examples', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ semanticMismatch: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.locator('#open-customizations').click();
    const ui = studio(page), session = await (await page.request.get(`${fixture.origin}/api/session`)).json();
    let exactItem = null;
    const read = async path => {
      const response = await page.request.get(`${fixture.origin}/api/${scopedPath(page, path, exactItem)}`, { headers: { 'x-session-context': session.contextToken } });
      expect(response.ok(), await response.text()).toBe(true); return response.json();
    };
    const selection = (await read('extensions')).selection;
    const nativeBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const mutations = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/extensions\/[^/]+\/(approve|activate)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
    });
    await send(page, `When I complete a task in ${fixture.metadata.projectName}, create ${fixture.metadata.title}. Other projects should create nothing.`);
    await expect(page).toHaveURL(/#customization=[^&]+/);
    exactItem = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    await expect(ui.getByText(fixture.metadata.mismatchText, { exact: true })).toBeVisible({ timeout: 20_000 });
    const { current: failed, transcript: failedTranscript } = await read('authoring');
    expect(failed.status).toBe('REVIEW_AVAILABLE'); expect(failed.review.eligible).toBe(false);
    const failedMessages = failedTranscript.messages;
    expect(failedMessages.at(-1).receipt.evidenceId).toBe(failed.review.evidenceId);
    const wrong = await read(`extensions/revisions/${failed.review.revisionId}`);
    expect(wrong.source).toBe(fixture.metadata.wrongSource); expect(wrong.cases).toEqual(fixture.metadata.cases);
    const failedProof = await read(`extensions/evidence/${failed.review.evidenceId}`);
    expect(failedProof.passed).toBe(false);
    const nonmatch = failedProof.reports.find(item => item.id === 'other-project');
    expect(nonmatch.expected.createdTasks).toEqual([]);
    expect(nonmatch.report.observed).toEqual({ effect: 'NOT_OBSERVED', createdTasks: null });
    expect(nonmatch.report.status).toBe('FAIL'); expect(nonmatch.report.mismatches.length).toBeGreaterThan(0);
    await ui.getByText(fixture.metadata.mismatchText, { exact: true }).locator('..').getByRole('button', { name: 'View checked examples', exact: true }).click();
    await ui.getByText('Other checked examples', { exact: true }).click();
    await ui.getByRole('button', { name: `Saved example: Completed task in “${fixture.metadata.otherProjectName}”`, exact: true }).click();
    const mismatch = ui.locator('.rs-example:visible');
    await expect(mismatch).toHaveCount(1);
    await expect(mismatch.locator('.rs-mismatch')).toHaveText('Task creation was not confirmed in this example');
    await expect(mismatch.locator('dd')).toHaveText(['Create no task.', 'No task-creation result was observed.']);
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
    expect((await read('extensions')).approved).toBe(false); expect((await read('extensions')).selection).toEqual(selection);
    expect(mutations).toEqual([]);
    expect(fixture.requests.map(item => item.name)).toEqual(['discover_catalog', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);

    await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    expect(fixture.requests).toHaveLength(5);
    await send(page, 'Correct the saved source so only completed tasks in the chosen project create the named task. Keep exactly the same independent expected examples.');
    await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
    const { current: repaired, transcript: repairedTranscript } = await read('authoring');
    expect(repaired.id).toBe(failed.id); expect(repaired.version).toBe(failed.version + 1); expect(repaired.review.eligible).toBe(true);
    expect(repairedTranscript.messages.slice(0, failedMessages.length)).toEqual(failedMessages);
    expect(repaired.review.evidenceId).not.toBe(failed.review.evidenceId);
    const saved = await read(`extensions/revisions/${repaired.review.revisionId}`);
    expect(saved.source).toBe(fixture.metadata.source); expect(saved.cases).toEqual(wrong.cases);
    const passedProof = await read(`extensions/evidence/${repaired.review.evidenceId}`);
    expect(passedProof.passed).toBe(true); expect(passedProof.reports.every(item => item.report.status === 'PASS')).toBe(true);
    expect((await read(`extensions/evidence/${failed.review.evidenceId}`))).toEqual(failedProof);
    expect((await read(`extensions/revisions/${failed.review.revisionId}`))).toEqual(wrong);
    await openSavedChanges(page);
    await expect(decision(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await expect(decision(page).locator('.rs-example:visible')).toHaveCount(1);
    await decision(page).getByText('Exact saved change and checks', { exact: true }).click();
    await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(fixture.metadata.source);
    for (let index = 0; index < saved.cases.length; index++)
      await expect(ui.getByLabel(`Saved example ${index + 1} for approval`, { exact: true })).toHaveText(wrong.cases[index]);
    await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    await expect(ui.getByLabel('I reviewed these sample results and want this advice for my tasks.')).toHaveCount(0);
    expect((await read('extensions')).selection).toEqual(selection);
    await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
    await expect(ui.getByLabel('Customization status', { exact: true })).toContainText('In use');
    await expect(ui.getByRole('article', { name: 'Advice is on', exact: true })).toHaveCount(0);
    await expect(ui.getByLabel('Message to Studio', { exact: true })).toBeVisible();
    await expect.poll(async () => (await read('extensions')).selection.revision.id).toBe(repaired.review.revisionId);
    expect(mutations).toHaveLength(2);
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);
    await openDetails(page);
    await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
    await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText(fixture.metadata.source);
    await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    await expect(ui.getByLabel('I reviewed these sample results and want this advice for my tasks.')).toHaveCount(0);
    expect(mutations).toHaveLength(2);
    expect(fixture.requests.map(item => item.name)).toEqual(Array.from({ length: 2 }, () => ['discover_catalog', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']).flat());
    expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(3_194_880);
  } finally { await fixture.close(); }
});

test('offline Studio resumes the same checked draft and preserves review when the guide becomes unavailable', async ({ page }) => {
  test.setTimeout(60_000);
  const resumeRequest = 'Please go ahead with the change we just discussed.';
  const fixture = await startAuthoringFixture({ resumeRequest, provider: 'anthropic' });
  let releaseRefresh;
  const holdRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
    await page.locator('#open-customizations').click();
    const ui = studio(page);
    await send(page, `Add ${fixture.metadata.title} after I finish a task in ${fixture.metadata.projectName}.`);
    await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await send(page, 'Yes, only for that project. Include an example from another project.');
    await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });

    const session = await (await page.request.get(`${fixture.origin}/api/session`)).json();
    const exactItem = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    const read = async path => {
      const response = await page.request.get(`${fixture.origin}/api/${scopedPath(page, path, exactItem)}`, { headers: { 'x-session-context': session.contextToken } });
      expect(response.ok(), await response.text()).toBe(true); return response.json();
    };
    const { current: checked, transcript } = await read('authoring');
    expect(checked.review.eligible).toBe(true);
    const evidencePath = scopedPath(page, `extensions/evidence/${checked.review.evidenceId}`, exactItem);
    const proof = await read(`extensions/evidence/${checked.review.evidenceId}`);
    expect(proof.passed).toBe(true);
    const { selection } = await read('extensions');
    const nativeBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const mutations = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/extensions\/[^/]+\/(approve|activate)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
    });
    const callsBefore = fixture.requests.length;

    await send(page, 'What happened in the matching example and the one from a different project?');
    await expect(ui.getByText(fixture.metadata.explanation, { exact: true })).toBeVisible();
    await send(page, resumeRequest);
    await expect.poll(async () => {
      const { current } = await read('authoring');
      return current?.version === checked.version + 2 && !['RUNNING', 'CANCELLING'].includes(current.status);
    }, { timeout: 15_000 }).toBe(true);
    const { current: resumed, transcript: resumedTranscript } = await read('authoring');
    expect(fixture.requests.slice(callsBefore).map(item => item.name)).toEqual(['discover_catalog', 'text', 'discover_catalog', 'offer_review']);
    expect(resumed).toMatchObject({ status: 'REVIEW_AVAILABLE', code: null });
    expect(resumed.id).toBe(checked.id);
    expect(resumed.review).toEqual(checked.review);
    expect(resumed.draft).toEqual(checked.draft);
    expect(resumedTranscript.messages.slice(0, transcript.messages.length)).toEqual(transcript.messages);
    expect(resumedTranscript.messages.at(-1).receipt.evidenceId).toBe(checked.review.evidenceId);

    const blockedText = 'Please explain this saved change again.';
    const recoveryRequests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/authoring/recover') recoveryRequests.push(request);
    });
    await page.route('**/api/authoring/turn', route => route.fulfill({ status: 503,
      json: { code: 'AUTHORING_GUIDE_UNAVAILABLE' } }), { times: 1 });
    await page.route('**/api/authoring?*', async route => {
      const response = await route.fetch();
      const saved = await response.json();
      saved.availability = { ...saved.availability, available: false, code: 'AUTHORING_GUIDE_UNAVAILABLE' };
      await holdRefresh;
      await route.fulfill({ response, json: saved });
    }, { times: 1 });
    const refresh = page.waitForRequest(request => new URL(request.url()).pathname === '/api/authoring' && request.method() === 'GET');
    await send(page, blockedText);
    await refresh;
    await expect(ui.getByRole('alert')).toContainText('native tasks and saved work remain available');
    await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue(blockedText);
    await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(ui.getByText('Submitted request', { exact: true })).toHaveCount(0);
    expect(recoveryRequests).toEqual([]);
    expect(fixture.requests).toHaveLength(callsBefore + 4);

    await expect(decision(page)).toHaveCount(0);
    const evidenceResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${evidencePath}`);
    await expect(ui.getByText(fixture.metadata.resumedOffer, { exact: true })).toHaveCount(0);
    await ui.getByText('The saved check is available to inspect.', { exact: true }).locator('..').getByRole('button', { name: 'View saved changes', exact: true }).click();
    expect(await (await evidenceResponse).json()).toEqual(proof);
    await expect(decision(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    const state = await read('extensions');
    expect(state.approved).toBe(false);
    expect(state.selection).toEqual(selection);
    expect(mutations).toEqual([]);
    await decision(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
    await expect(decision(page).getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
    expect((await read('extensions')).selection).toEqual(selection);
    expect(mutations).toHaveLength(1);
    await decision(page).getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
    await expect.poll(async () => (await read('extensions')).selection.revision?.id).toBe(checked.review.revisionId);
    expect(mutations).toHaveLength(2);
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);
  } finally { releaseRefresh(); await fixture.close(); }
});

for (const [provider, width] of [['openai', 1440], ['anthropic', 390]]) {
  test(`offline ${provider} native loop reaches real exact human review and Use (${width}px)`, async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await startAuthoringFixture({ provider, unconfigured: provider === 'openai',
      ...(provider === 'anthropic' && { projectName: 'Delivery planning', title: 'Prepare delivery review' }) });
    try {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      if (provider === 'openai') {
        await navigate(page, 'Customizations');
        await page.getByRole('button', { name: 'New customization', exact: true }).click();
        await expect(authoring(page)).toContainText('Set up the assistant to create or change a customization.');
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
        await expect(studio(page).locator('.rs-chat-note')).toContainText('Messages use your configured assistant');
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
      await navigate(page, 'Tasks');
      await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
      await page.getByLabel('Task title', { exact: true }).fill('Unsaved native title during offline authoring');
      await page.locator('#open-customizations').click();
      const ui = studio(page), panel = authoring(page);
      await expect(ui.locator('.rs-chat-note')).toContainText('Messages use your configured assistant');
      expect(fixture.requests).toEqual([]);
      await expect(ui.locator('.rs-chat')).not.toContainText(provider);
      const selectedA = fixture.db.prepare("SELECT revision_id,generation FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get();
      await openDetails(page);
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
      await send(page, `When I complete a task in ${fixture.metadata.projectName}, create ${fixture.metadata.title}. Other projects should create nothing.`);
      await expect(page).toHaveURL(/#customization=[^&]+/);
      await expect(ui.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
      expect(turns).toBe(1);
      expect(fixture.requests.map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification']);
      await send(page, `Confirmed: create ${fixture.metadata.title} only after a completion in ${fixture.metadata.projectName}. Keep the independent matching, nonmatching and unavailable-task examples.`);
      await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
      if (provider === 'openai') {
        await page.setViewportSize({ width: 683, height: 384 });
        await expect(ui.getByRole('button', { name: 'View saved changes', exact: true }).first()).toBeInViewport({ ratio: 1 });
        mkdirSync(resolve('build/screens'), { recursive: true });
        await page.screenshot({ path: resolve('build/screens', 'authoring-offer-short-finished.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      expect(turns).toBe(2);
      expect(fixture.requests.map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification',
        'discover_catalog', 'compile_draft', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);

      const session = await (await page.request.get(`${fixture.origin}/api/session`)).json();
      const exactItem = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
      const read = async path => {
        const response = await page.request.get(`${fixture.origin}/api/${scopedPath(page, path, exactItem)}`, { headers: { 'x-session-context': session.contextToken } });
        expect(response.ok(), await response.text()).toBe(true); return response.json();
      };
      const { current: conversation, transcript } = await read('authoring');
      expect(conversation.status).toBe('REVIEW_AVAILABLE'); expect(conversation.review.eligible).toBe(true);
      expect(conversation.version).toBe(2); expect(conversation.draft.draftVersion).toBe(2);
      expect(transcript.messages.filter(message => message.role === 'assistant' && message.text === fixture.metadata.question)).toHaveLength(1);
      expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(8 * (provider === 'openai' ? 319488 : 77824));
      const state = await read('extensions');
      const nativeBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
      expect(state.selection.revision?.id ?? null).toBe(selectedA.revision_id);
      expect(state.selection.generation).toBe(selectedA.generation); expect(state.approved).toBe(false);
      const saved = await read(`extensions/revisions/${conversation.review.revisionId}`);
      expect(saved.source).toBe(fixture.metadata.source); expect(saved.cases).toEqual(fixture.metadata.cases);
      const program = JSON.parse(saved.source);
      expect(program.entrypoint).toBe('TaskCompleted');
      expect(program.steps[0].let.literal).toBe(fixture.metadata.projectId);
      expect(program.steps[3].args.title.literal).toBe(fixture.metadata.title);
      const evidenceRequests = [];
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/extensions\/[^/]+\/evidence\//.test(path)) evidenceRequests.push(path.split('/').at(-1));
      });
      await ui.getByLabel('Message to Studio', { exact: true }).fill('Keep this unsent refinement while reviewing');
      await openSavedChanges(page);
      await expect(decision(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
      const proof = await read(`extensions/evidence/${conversation.review.evidenceId}`);
      expect(proof.reports.map(item => item.id)).toEqual(['matching-project', 'other-project', 'unfinished-task', 'missing-task', 'access-denied', 'read-unavailable']);
      expect(proof.passed).toBe(true);
      expect(proof.reports[0].expected.createdTasks).toEqual([{ projectId: fixture.metadata.projectId, projectName: fixture.metadata.projectName, title: fixture.metadata.title }]);
      expect(proof.reports[0].report.observed).toEqual({ effect: 'CONFIRMED', createdTasks: proof.reports[0].expected.createdTasks });
      expect(proof.reports[1].expected.createdTasks).toEqual([]);
      expect(proof.reports[1].report.observed).toEqual({ effect: 'NONE', createdTasks: [] });
      await ui.getByText(/^Other checked examples/).click();
      const examples = decision(page).getByRole('article', { name: /^Example:/ });
      await expect(examples).toHaveCount(proof.reports.length);
      for (const [index, report] of proof.reports.entries()) {
        const example = examples.nth(index);
        await expect(example).toBeVisible();
        await expect(example.locator('h4')).toHaveText(report.report.scenario.task.title);
        await expect(example.locator('dd').first()).toContainText(index === 0 ? fixture.metadata.title : 'Create no task.');
        await expect(example.locator('.rs-match')).toHaveCount(1);
        if (!index) {
          const exact = decision(page).getByLabel('Exact checked examples', { exact: true });
          await expect(exact).toBeHidden();
          await decision(page).getByText('Exact saved change and checks', { exact: true }).click();
          await expect(exact).toContainText('matching-project');
          await decision(page).getByText('Exact saved change and checks', { exact: true }).click();
        }
      }
      expect(evidenceRequests).toEqual([conversation.review.evidenceId]);
      await expect(ui.getByLabel('Message to Studio', { exact: true })).toHaveValue('Keep this unsent refinement while reviewing');
      await expect(decision(page)).toContainText('These were example tasks; your real tasks have not changed.');
      await ui.getByText('Exact saved change and checks', { exact: true }).click();
      await expect(ui.getByLabel('Saved source for approval', { exact: true })).toHaveText(fixture.metadata.source);
      for (let index = 0; index < fixture.metadata.cases.length; index++)
        await expect(ui.getByLabel(`Saved example ${index + 1} for approval`, { exact: true })).toHaveText(fixture.metadata.cases[index]);
      expect((await read('extensions')).approved).toBe(false);
      mkdirSync(resolve('build/screens'), { recursive: true });
      await page.screenshot({ path: resolve('build/screens', `authoring-integrated-${provider}.png`), fullPage: true });
      await ui.getByRole('button', { name: 'Approve this change', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
      await expect(ui.getByLabel('I reviewed these sample results and want this advice for my tasks.')).toHaveCount(0);
      await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toBeEnabled();
      expect((await read('extensions')).selection.revision?.id ?? null).toBe(selectedA.revision_id);
      await ui.getByRole('button', { name: 'Turn on for my tasks', exact: true }).click();
      await expect(ui.getByLabel('Customization status', { exact: true })).toContainText('In use');
      await expect(ui.getByRole('article', { name: 'Advice is on', exact: true })).toHaveCount(0);
      if (!await ui.getByLabel('Message to Studio', { exact: true }).isVisible())
        await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(ui.getByLabel('Message to Studio', { exact: true })).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      await expect.poll(async () => (await read('extensions')).selection.revision.id).toBe(conversation.review.revisionId);
      expect((await read('extensions')).selection.generation).toBe(selectedA.generation + 1);
      expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore, 'Checking, approval and activation make no native task changes.');
      await ui.getByRole('button', { name: 'Back to my task', exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Unsaved native title during offline authoring');
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await selectProject(page, fixture.metadata.projectName);
      const sourceTitle = `Finish ${provider} customer work`;
      await addTask(page, sourceTitle);
      const source = fixture.db.prepare("SELECT id FROM tasks WHERE owner_id='maya' AND title=?").get(sourceTitle);
      await page.getByRole('button', { name: `Complete ${sourceTitle}`, exact: true }).click();
      const nativeOutcome = page.getByRole('region', { name: 'Customization outcome', exact: true });
      await expect(nativeOutcome.getByRole('button', { name: `Open task: ${fixture.metadata.title}`, exact: true })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await read(`tasks/${source.id}/reaction`)).state).toBe('FINISHED');
      const first = await read(`tasks/${source.id}/reaction`);
      expect(first.receipt).toMatchObject({ kind: 'SUCCESS', effect: 'CONFIRMED' });
      expect(first.outcome.classification).toBe('COMPLETED');
      const createdId = first.receipt.value.id;
      expect(await read(`tasks/${createdId}`)).toMatchObject({ projectId: fixture.metadata.projectId, title: fixture.metadata.title, status: 'open' });
      await nativeOutcome.getByRole('button', { name: `Open task: ${fixture.metadata.title}`, exact: true }).click();
      await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(fixture.metadata.title);
      expect(fixture.db.prepare("SELECT count(*) n FROM tasks WHERE owner_id='maya' AND project_id=? AND title=?").get(fixture.metadata.projectId, fixture.metadata.title).n).toBe(1);
      const admission = fixture.db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(source.id);
      const repeated = await page.request.post(`${fixture.origin}/api/tasks/${source.id}/complete`, {
        headers: { origin: fixture.origin, 'content-type': 'application/json', 'x-session-context': session.contextToken }, data: {} });
      expect(repeated.ok(), await repeated.text()).toBe(true);
      expect(await repeated.json()).toEqual(await read(`tasks/${source.id}`));
      expect(await read(`tasks/${source.id}/reaction`)).toEqual(first);
      expect(fixture.db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(source.id)).toEqual(admission);
      expect(fixture.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n).toBe(1);
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await page.getByRole('button', { name: `Complete ${fixture.metadata.title}`, exact: true }).click();
      await expect.poll(async () => (await read(`tasks/${createdId}/reaction`)).state).toBe('FINISHED');
      const later = await read(`tasks/${createdId}/reaction`);
      expect(later.receipt).toMatchObject({ kind: 'SUCCESS', effect: 'CONFIRMED' });
      expect(later.receipt.value.id).not.toBe(createdId);
      expect(await read(`tasks/${later.receipt.value.id}`)).toMatchObject({ projectId: fixture.metadata.projectId, title: fixture.metadata.title, status: 'open' });
      const laterAdmission = fixture.db.prepare('SELECT event_id,original_key FROM task_completion_events WHERE source_task_id=?').get(createdId);
      expect(laterAdmission.event_id).not.toBe(admission.event_id); expect(laterAdmission.original_key).not.toBe(admission.original_key);
      expect(fixture.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n).toBe(2);
      await selectProject(page, fixture.metadata.otherProjectName);
      const nonmatchTitle = `Finish unrelated ${provider} work`;
      await addTask(page, nonmatchTitle);
      const nonmatch = fixture.db.prepare("SELECT id FROM tasks WHERE owner_id='maya' AND title=?").get(nonmatchTitle);
      await page.getByRole('button', { name: `Complete ${nonmatchTitle}`, exact: true }).click();
      await expect.poll(async () => (await read(`tasks/${nonmatch.id}/reaction`)).state).toBe('FINISHED');
      const skipped = await read(`tasks/${nonmatch.id}/reaction`);
      expect(skipped.receipt).toBeNull();
      expect(skipped.outcome).toMatchObject({ classification: 'COMPLETED', result: { status: 'NO_OP' }, effects: [] });
      await expect(nativeOutcome.getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
      expect(fixture.db.prepare('SELECT count(*) n FROM task_effect_receipts').get().n).toBe(2);
      const callCount = fixture.requests.length;
      if (provider === 'openai') {
        await page.setViewportSize({ width: 683, height: 384 });
        await selectProject(page, fixture.metadata.projectName);
        await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
        await page.locator('#open-customizations').click();
        await expect(ui.getByRole('button', { name: 'History and details', exact: true })).toBeInViewport({ ratio: 1 });
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
        await navigate(page, 'Tasks');
        await selectProject(page, fixture.metadata.projectName);
        await page.getByRole('button', { name: 'Gather material references', exact: true }).click();
        await page.locator('#open-customizations').click();
        const intended = 'Refine the saved task customization after replacing assistant settings.';
        await ui.getByLabel('Message to Studio', { exact: true }).fill(intended);
        await openDetails(page);
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
        await expect(ui.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible();
        await expect(ui.getByText(intended, { exact: true })).toBeVisible();
        await expect.poll(async () => (await read('authoring')).current?.status).toBe('AWAITING_USER');
        expect((await read('authoring')).current.id).not.toBe(conversation.id);
        await expect(ui.getByText(fixture.metadata.question, { exact: true })).toHaveCount(2);
        await expect(panel.getByRole('button', { name: 'Retry submitted request', exact: true })).toHaveCount(0);
        expect(fixture.requests.slice(callCount).map(item => item.name)).toEqual(['discover_catalog', 'ask_clarification']);
        expect((await read('extensions')).selection.revision.id).toBe(conversation.review.revisionId);
        expect(turns).toBe(3);
      }
      const requestsBeforeSwitch = fixture.requests.length;
      const heldBeforeSwitch = fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
      await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('leo');
      const foreignSession = await (await page.request.get(`${fixture.origin}/api/session`)).json();
      const foreignTask = await page.request.get(`${fixture.origin}/api/tasks/${createdId}`, { headers: { 'x-session-context': foreignSession.contextToken } });
      expect(foreignTask.status()).toBe(404);
      const foreignOutcome = await page.request.get(`${fixture.origin}/api/tasks/${source.id}/reaction`, { headers: { 'x-session-context': foreignSession.contextToken } });
      expect(foreignOutcome.status()).toBe(404);
      await page.getByLabel('Demo person', { exact: true }).selectOption('maya');
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
      const returnedSession = await (await page.request.get(`${fixture.origin}/api/session`)).json();
      const retained = await page.request.get(`${fixture.origin}/api/tasks/${source.id}/reaction`, { headers: { 'x-session-context': returnedSession.contextToken } });
      expect(retained.status()).toBe(200); expect(await retained.json()).toEqual(first);
      expect(fixture.requests).toHaveLength(requestsBeforeSwitch);
      expect(fixture.db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros).toBe(heldBeforeSwitch);
    } finally { await fixture.close(); }
  });
}
