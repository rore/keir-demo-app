import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const review = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });
const behavior = page => studio(page).getByRole('article', { name: 'About this rule', exact: true });
const composer = page => studio(page).getByLabel('Message to Daymark assistant', { exact: true });
const turnOn = page => review(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true });
const reviewLink = page => studio(page).getByRole('button', { name: /^(View saved changes|View latest changes)$/ }).first();
const decisions = page => review(page).getByRole('button', {
  name: /^(Approve this change|Turn on for tasks completed)$/, disabled: false,
});
const draftInput = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });

async function api(request, origin, path, data) {
  const session = await (await request.get(origin + '/api/session')).json();
  const response = await request.fetch(origin + '/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { origin, 'X-Session-Context': session.contextToken },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(page, other, fixture) {
  const { origin, db, metadata } = fixture;
  await page.goto(origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const second = await api(other, origin, 'session', { userId: 'maya' });
  const first = await (await page.request.get(origin + '/api/session')).json();
  expect(second.user.id).toBe(first.user.id);
  expect(second.contextToken).not.toBe(first.contextToken);

  const { extensionId } = admitTaskDraft(db, createLifecycle(db), { name: 'Exact proof review' });
  const path = 'extensions/' + extensionId;
  const write = (operation, data) => api(other, origin, path + '/' + operation, data);
  const draft = await write('compile', { hookId: TASK_HOOK, source: metadata.source, draftVersion: 0 });
  const saved = await write('scenarios', { ...draftInput(draft), cases: metadata.cases });
  expect(saved.selection.revision).toBeNull();
  return { extensionId, path, write, input: draftInput(saved) };
}

async function openItem(page, id) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator(`[id="edit-${id}"]`).click();
  await expect(composer(page)).toBeVisible();
}

async function expectProof(page, id) {
  const proofId = review(page).getByText('Evidence: ' + id, { exact: true });
  if (!await proofId.isVisible()) await review(page).getByText('Exact saved change and checks', { exact: true }).click();
  await expect(proofId).toBeVisible();
}

async function expectIllustration(page, expectedTitle) {
  await expect(behavior(page)).toContainText('About this rule');
  await expect(behavior(page)).toContainText(`Create a task titled “${expectedTitle}”`);
  await expect(behavior(page)).toContainText('A full summary isn’t available for this version.');
  await expect(behavior(page)).not.toContainText('Completed example task');
}

async function holdNext(page, url, { afterResponse = false } = {}) {
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  await page.route(url, async route => {
    const response = afterResponse ? await route.fetch() : null;
    started.resolve(route.request());
    await released.promise;
    if (response) await route.fulfill({ response });
    else await route.continue();
  }, { times: 1 });
  return { started: started.promise, release: released.resolve };
}

test('the rule summary rejects artifact bytes that differ from the saved revision pin', async ({ page, request }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { extensionId, input } = await seed(page, request, fixture);
    const url = `**/api/extensions/${extensionId}/revisions/${input.revisionId}`;
    const changedTitle = 'Unverified follow-up';
    await page.route(url, async route => {
      const response = await route.fetch();
      const saved = await response.json();
      const artifact = saved.artifact.replace(fixture.metadata.title, changedTitle);
      expect(artifact).not.toBe(saved.artifact);
      await route.fulfill({ response, json: { ...saved, artifact } });
    });
    const served = page.waitForResponse(response => response.url().endsWith(`/revisions/${input.revisionId}`));
    await openItem(page, extensionId);
    await served;
    await expect(behavior(page)).toContainText('A full summary isn’t available for this version.');
    await expect(behavior(page)).not.toContainText(changedTitle);
    await page.unroute(url);
    await page.reload();
    await expectIllustration(page, fixture.metadata.title);
    await expect(review(page)).toBeHidden();
  } finally { await fixture.close(); }
});

test('a competing approval cannot substitute its proof during turn-on', async ({ page, request }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true, projectName: 'Studio QA' });
  let hold;
  try {
    const { origin, metadata } = fixture;
    const { extensionId, path, write, input } = await seed(page, request, fixture);
    const proofB = (await write('simulate', input)).evidence;
    const proofA = (await write('simulate', input)).evidence;
    expect(proofA.passed && proofB.passed).toBe(true);
    expect(proofA.id).not.toBe(proofB.id);
    const approvedA = await write('approve', { ...input, evidenceId: proofA.id });

    await openItem(page, extensionId);
    await expectIllustration(page, metadata.title);
    await expect(behavior(page)).toContainText('A task is completed.');
    await expect(behavior(page)).toContainText('in “Studio QA”');
    await expect(review(page)).toBeHidden();
    await composer(page).fill('Keep my unsent next change');
    await reviewLink(page).click();
    await expect(review(page).getByRole('heading', { name: 'Simulation', exact: true })).toBeVisible();
    await expect(turnOn(page)).toBeEnabled();
    await expectProof(page, proofA.id);

    const url = `${origin}/api/${path}/activate`;
    const activateBodies = [];
    page.on('request', pending => {
      if (pending.method() === 'POST' && pending.url() === url) activateBodies.push(pending.postDataJSON());
    });
    hold = await holdNext(page, url);
    await turnOn(page).click();
    const pending = await hold.started;
    const requestA = { ...input, generation: approvedA.selection.generation, evidenceId: proofA.id };
    expect(pending.postDataJSON()).toEqual(requestA);
    const approvedB = await write('approve', { ...input, evidenceId: proofB.id });
    expect(approvedB.evidence.id).toBe(proofA.id);
    expect(approvedB.approvedEvidenceId).toBe(proofB.id);
    expect(approvedB.selection).toEqual(approvedA.selection);
    expect(approvedB.history).toEqual(approvedA.history);

    const conflict = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST');
    const readback = page.waitForResponse(response => response.url() === `${origin}/api/${path}` && response.request().method() === 'GET');
    hold.release();
    expect((await conflict).status()).toBe(409);
    expect(await (await readback).json()).toMatchObject({ approvedEvidenceId: proofB.id, selection: approvedB.selection });
    await expect(reviewLink(page)).toBeEnabled();
    await expect(decisions(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue('Keep my unsent next change');
    await expectProof(page, proofA.id);
    const afterConflict = await api(request, origin, path);
    expect(afterConflict.selection).toEqual(approvedB.selection);
    expect(afterConflict.history).toEqual(approvedB.history);
    expect(afterConflict.approvedEvidenceId).toBe(proofB.id);
    expect(activateBodies).toEqual([requestA]);

    await reviewLink(page).click();
    await expect(turnOn(page)).toBeEnabled();
    await expectProof(page, proofB.id);
    const activated = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST');
    await turnOn(page).click();
    expect((await activated).ok()).toBe(true);
    await expect(review(page).getByText('On for my tasks', { exact: true })).toBeVisible();
    const afterTurnOn = await api(request, origin, path);
    expect(afterTurnOn.selection).toMatchObject({ generation: approvedB.selection.generation + 1,
      revision: { id: input.revisionId }, approvedEvidenceId: proofB.id });
    expect(afterTurnOn.history).toHaveLength(approvedB.history.length + 1);
    expect(activateBodies).toEqual([requestA, { ...requestA, evidenceId: proofB.id }]);
    await expectIllustration(page, metadata.title);
    await expect(composer(page)).toHaveValue('Keep my unsent next change');

    const revised = taskCustomizationFixture({ projectId: metadata.projectId, otherProjectId: metadata.otherProjectId,
      title: 'Revised example follow-up' });
    const draft = await write('compile', { hookId: TASK_HOOK, source: revised.source, draftVersion: input.draftVersion });
    const saved = await write('scenarios', { ...draftInput(draft), cases: revised.cases });
    expect(saved.evidence).toBeNull();
    await page.reload();
    await expectIllustration(page, revised.metadata.title);
    await expect(behavior(page).getByText(metadata.title, { exact: true })).toHaveCount(0);
    await expect(behavior(page).getByRole('button', { name: 'Check this revised change', exact: true })).toBeEnabled();
    await expect(review(page)).toBeHidden();
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

test('a held source read cannot offer a decision for an earlier draft when nothing is in use', async ({ page, request }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let hold;
  try {
    const { origin, metadata } = fixture;
    const { extensionId, path, write, input } = await seed(page, request, fixture);
    const checked = await write('simulate', input);
    expect(checked.evidence.passed).toBe(true);
    await openItem(page, extensionId);
    await expectIllustration(page, metadata.title);

    const mutations = [];
    page.on('request', pending => {
      if (pending.method() === 'POST' && pending.url().startsWith(`${origin}/api/${path}/`)) mutations.push(pending.url());
    });
    hold = await holdNext(page, `${origin}/api/${path}/revisions/${input.revisionId}`, { afterResponse: true });
    await reviewLink(page).click();
    await hold.started;
    const changed = await write('compile', { hookId: TASK_HOOK, source: metadata.source, draftVersion: input.draftVersion });
    expect(changed.draft.id).not.toBe(input.revisionId);
    expect(changed.selection.revision).toBeNull();

    const fresh = page.waitForResponse(response => response.url() === `${origin}/api/${path}` && response.request().method() === 'GET');
    hold.release();
    expect(await (await fresh).json()).toMatchObject({ draft: { id: changed.draft.id }, draftVersion: changed.draftVersion });
    await expect(review(page)).toContainText(/earlier saved|read-only|could not be confirmed/i);
    await expectProof(page, checked.evidence.id);
    await expect(decisions(page)).toHaveCount(0);
    expect(mutations).toEqual([]);
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

test('scrolling while a turn-off response is held leaves conversation focus in place', async ({ page, request }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let hold;
  try {
    const { origin } = fixture;
    const { extensionId, path, write, input } = await seed(page, request, fixture);
    const checked = await write('simulate', input);
    const approved = await write('approve', { ...input, evidenceId: checked.evidence.id });
    await write('activate', { ...input, generation: approved.selection.generation, evidenceId: checked.evidence.id });

    await openItem(page, extensionId);
    await page.setViewportSize({ width: 390, height: 844 });
    await reviewLink(page).click();
    await expect(review(page).getByText('On for my tasks', { exact: true })).toBeVisible();
    const log = studio(page).getByRole('log', { name: 'Studio conversation', exact: true });
    const disable = studio(page).getByRole('button', { name: 'Turn off this customization', exact: true });
    const url = `${origin}/api/${path}/disable`;
    await expect(disable).toBeEnabled();
    await log.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await composer(page).focus();
    hold = await holdNext(page, url, { afterResponse: true });
    // Dispatch the click without browser focus changes so only the wheel moves the reading position during the hold.
    await disable.dispatchEvent('click');
    await hold.started;
    const top = await log.evaluate(element => element.scrollTop);
    await log.hover();
    await page.mouse.wheel(0, -320);
    await expect.poll(() => log.evaluate(element => element.scrollTop)).toBeLessThan(top);
    await expect(composer(page)).toBeFocused();

    const disabled = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST');
    hold.release();
    expect(await (await disabled).json()).toMatchObject({ selection: { revision: null } });
    await expect(disable).toBeHidden();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(composer(page)).toBeFocused();
    expect(fixture.requests).toEqual([]);
  } finally { hold?.release(); await fixture.close(); }
});

test('a confirmed project mismatch distinguishes the expected and actual projects when both names are missing', async ({ page, request }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { origin, metadata } = fixture;
    const { extensionId, path, write, input } = await seed(page, request, fixture);
    const checked = await write('simulate', input);
    await openItem(page, extensionId);
    await expectIllustration(page, metadata.title);
    // Preserve real evidence IDs and task results while exercising a display-only mismatch projection.
    await page.route(`${origin}/api/${path}/evidence/${checked.evidence.id}`, async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const proof = await response.json(), example = proof.reports[0];
      expect(example.report.observed.effect).toBe('CONFIRMED');
      const expected = example.expected.createdTasks[0], observed = example.report.observed.createdTasks[0];
      expect(expected.projectId).toBe(metadata.projectId);
      delete expected.projectName;
      delete observed.projectName;
      expected.projectId = 'unknown-expected-project';
      observed.projectId = 'unknown-observed-project';
      example.report.status = 'FAIL';
      proof.passed = false;
      await route.fulfill({ response, json: proof });
    }, { times: 1 });

    await reviewLink(page).click();
    const outcomes = review(page).locator('dd');
    await expect(outcomes.filter({ hasText: /the expected example project/i })).toBeVisible();
    await expect(outcomes.filter({ hasText: /the different example project/i })).toBeVisible();
    await expect(review(page)).toContainText('The created task used a different project than expected.');
    await expect(review(page)).toContainText('Saved results unavailable for a decision');
    await expect(decisions(page)).toHaveCount(0);
    expect(fixture.requests).toEqual([]);
  } finally { await fixture.close(); }
});
