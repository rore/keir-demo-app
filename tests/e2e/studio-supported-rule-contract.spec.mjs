import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { loadHost } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCreateGuardFixture } from '../fixtures/task-create-guard.mjs';
import { taskWorkflowSource, taskWorkflowCases } from '../fixtures/task-workflow-source.mjs';

const capturedGuard = JSON.parse(readFileSync(new URL('../fixtures/task-guard-summary.json', import.meta.url)));
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const collection = page => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
const summary = page => studio(page).getByRole('article', { name: 'About this rule', exact: true });
const review = page => studio(page).getByRole('article', { name: 'Current decision', exact: true });

async function signIn(page, fixture, owner = 'maya') {
  if (owner === 'maya') {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  } else await page.getByLabel('Demo person', { exact: true }).selectOption(owner);
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue(owner);
  const session = await (await page.request.get(fixture.origin + '/api/session')).json();
  return { origin: fixture.origin, 'X-Session-Context': session.contextToken };
}

function guardProgram(projectId, otherProjectId) {
  const host = loadHost('TaskBeforeCreate');
  const program = taskCreateGuardFixture({ host, rule: 'project-priority', projectId, otherProjectId });
  // Reauthor the same rule shape for the discovered numeric contract; never mutate the captured fixture.
  return { ...program, source: capturedGuard.source.replaceAll('project2', 'chosenProject')
    .replaceAll('needsPriority', 'restricted').replaceAll('summary-project', projectId)
    .replace('language: keir/2', 'language: keir/3').replace("version: '5'", "version: '6'")
    .replace(JSON.parse(capturedGuard.artifact).modelRef.digest, host.pins.modelDigest) };
}

async function save(page, fixture, headers, hook, program, name, owner = 'maya', extensionId) {
  extensionId ??= admitTaskDraft(fixture.db, createLifecycle(fixture.db), { owner, name }).extensionId;
  const write = async (action, data) => {
    const response = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/${action}`, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const stateResponse = await page.request.get(`${fixture.origin}/api/extensions/${extensionId}`, { headers });
  expect(stateResponse.ok()).toBe(true);
  const previous = await stateResponse.json();
  const compiled = await write('compile', { hookId: hook, source: program.source, draftVersion: previous.draftVersion });
  const saved = await write('scenarios', { revisionId: compiled.draft.id, draftVersion: compiled.draftVersion, cases: program.cases });
  const checked = await write('simulate', { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
  expect(checked.evidence.passed).toBe(true);
  return { extensionId, checked };
}

async function assertFacts(target, facts) {
  for (const fact of facts) await expect(target).toContainText(fact);
  await expect(target).not.toContainText('description is unavailable');
  await expect(target).not.toContainText('A full summary');
  await expect(target).not.toContainText('saved conditions can’t be summarized');
}

async function turnOn(page, hook) {
  await review(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  const label = hook === 'TaskBeforeCreate' ? 'Turn on for new tasks' : hook === 'TaskCreated' ? 'Turn on for tasks added' : 'Turn on for tasks completed';
  await review(page).getByRole('button', { name: label, exact: true }).click();
  await expect(studio(page).locator('#studio-use-confirmed')).toBeFocused();
}

for (const hook of ['TaskBeforeCreate', 'TaskCreated', 'TaskCompleted']) {
  test(`compiled ${hook} behavior is readable in collection, Summary, Simulation and reopen`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      const headers = await signIn(page, fixture);
      const { projectId, otherProjectId, projectName, otherProjectName } = fixture.metadata;
      const options = { projectId, destinationProjectId: otherProjectId };
      const workflow = hook === 'TaskCreated' ? 'intake' : 'review';
      const program = hook === 'TaskBeforeCreate' ? guardProgram(projectId, otherProjectId)
        : { source: taskWorkflowSource(loadHost(hook), workflow, options).toString('utf8'), cases: taskWorkflowCases(loadHost(hook), workflow, options) };
      const name = `My saved ${hook} behavior`, { extensionId } = await save(page, fixture, headers, hook, program, name);
      const facts = hook === 'TaskBeforeCreate' ? [`the task is in “${projectName}”`, 'priority is Normal', 'Choose a priority for this task.', 'normal permission, validation and save checks']
        : hook === 'TaskCreated' ? ['set its priority to High', `“${projectName}”`, 'Quote for spring launch', 'tag “client”']
          : ['create a new task titled “Review”', `“${projectName}”`, `“${otherProjectName}”`, '7 days', 'tag “review”'];
      const nativeRows = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
      await collection(page);
      const card = page.getByRole('article', { name, exact: true });
      await assertFacts(card, facts);
      await expect(card.getByRole('heading', { name, exact: true })).toBeVisible();
      await page.locator('#edit-' + extensionId).click();
      await assertFacts(summary(page), facts);
      await studio(page).locator('#studio-view-saved').click();
      const primaryFacts = summary(page).getByRole('definition');
      await expect(primaryFacts).toHaveCount(3);
      for (const fact of await primaryFacts.all()) await expect(fact).toBeVisible();
      if (hook === 'TaskBeforeCreate') await expect(summary(page).getByText('Stops saving when', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${hook}-summary.png`) });
      await studio(page).locator('#studio-view-saved').click();
      await expect(review(page)).toContainText('Example tasks; your tasks are unchanged.');
      const nextStep = review(page).getByRole('button', { name: 'Go to approval', exact: true });
      await expect(nextStep).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${hook}-simulation.png`) });
      for (const [width, height] of [[1440, 1000], [390, 844], [683, 384]]) {
        await page.setViewportSize({ width, height });
        await nextStep.click();
        await expect(review(page).locator('#studio-decision-step')).toBeFocused();
        await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (hook === 'TaskBeforeCreate') {
        await expect(review(page)).toContainText('Allowed by this rule');
        await expect(review(page)).toContainText('Choose a priority for this task.');
        const safety = review(page).getByRole('article', { name: 'Example: Safety check: required check unavailable', exact: true });
        await expect(safety).toContainText('High priority');
        await expect(safety).toContainText('This example deliberately');
        await expect(safety).toContainText('The rule did not run.');
        await expect(safety).toContainText('Saving stopped as expected');
      } else await expect(review(page)).toContainText(hook === 'TaskCreated' ? 'Priority High' : 'Review');
      await collection(page);
      await assertFacts(page.getByRole('article', { name, exact: true }), facts);
      await page.locator('#edit-' + extensionId).click();
      await assertFacts(summary(page), facts);
      expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeRows);
      await studio(page).locator('#studio-view-saved').click();
      await turnOn(page, hook);
      await collection(page);
      await assertFacts(card, facts);
      await expect(card.getByRole('heading', { name: /^What’s in use:/ })).toHaveCount(1);
      await expect(card.getByRole('heading', { name: /^Proposed changes:/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${hook}-collection.png`) });
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}

test('created task values are separate from the trigger and naming requires an explicit save', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ unconfigured: true, title: 'Follow up' });
  try {
    const headers = await signIn(page, fixture);
    const name = 'My chosen business name';
    const { extensionId } = await save(page, fixture, headers, 'TaskCompleted', {
      source: fixture.metadata.source, cases: fixture.metadata.cases,
    }, name);
    await collection(page); await page.locator('#edit-' + extensionId).click();
    await studio(page).locator('#studio-view-saved').click();
    const example = review(page).getByRole('region', { name: 'Triggering task and created example', exact: true });
    await expect(example.getByText('Triggering example task', { exact: true })).toBeVisible();
    const created = example.locator('.rs-task-after');
    await expect(created).toContainText('Follow up');
    await expect(created).toContainText('Tags: None');
    await expect(created).toContainText('Other task details were not checked here.');
    await expect(created).not.toContainText('Not recorded');
    await expect(created.locator('.rs-changed-field')).toHaveCount(1);
    await expect(example).not.toContainText('Before this change');

    await studio(page).getByRole('button', { name: 'More', exact: true }).click();
    const rename = studio(page).getByRole('button', { name: 'Rename', exact: true });
    await rename.click();
    const form = studio(page).getByRole('form', { name: 'Rename customization', exact: true });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue(name);
    for (const [width, height] of [[390, 844], [683, 384]]) {
      await page.setViewportSize({ width, height });
      await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
      await expect(form.getByLabel('Name', { exact: true })).toBeInViewport();
      await form.getByLabel('Name', { exact: true }).press('Tab');
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Tab'); await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(form.getByRole('button', { name: 'Use suggested name', exact: true })).toBeFocused();
      await expect(form.getByRole('button', { name: 'Use suggested name', exact: true })).toBeInViewport({ ratio: 1 });
      await form.getByLabel('Name', { exact: true }).focus();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`explicit-name-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await form.getByRole('button', { name: 'Use suggested name', exact: true }).click();
    const suggestion = 'Create “Follow up” tasks';
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue(suggestion);
    const currentName = async () => (await (await page.request.get(`${fixture.origin}/api/extensions/${extensionId}`, { headers })).json()).extension.name;
    expect(await currentName()).toBe(name);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await currentName()).toBe(name);
    await rename.click();
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue(name);
    await form.getByRole('button', { name: 'Use suggested name', exact: true }).click();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(studio(page).locator('#studio-title')).toHaveText(suggestion);
    expect(await currentName()).toBe(suggestion);
    await studio(page).locator('#studio-view-saved').click();
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('tag updates distinguish a recorded empty starting list from an unrecorded list', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const headers = await signIn(page, fixture), host = loadHost('TaskCreated');
    const options = { projectId: fixture.metadata.projectId, destinationProjectId: fixture.metadata.otherProjectId };
    const source = JSON.parse(taskWorkflowSource(host, 'missing-due', options));
    source.steps.find(step => step.call === 'tasks.update').args = { addTag: { literal: 'next' } };
    const cases = taskWorkflowCases(host, 'missing-due', options).map(text => {
      const row = JSON.parse(text);
      for (const call of [...row.stubs, ...row.expect.calls]) {
        if (call.capability === 'tasks.get' && call.response?.kind === 'SUCCESS') call.response.value.tags = [];
        if (call.capability === 'tasks.update') call.args = { addTag: 'next' };
      }
      return JSON.stringify(row);
    });
    const { extensionId } = await save(page, fixture, headers, 'TaskCreated', { source: JSON.stringify(source), cases }, 'Tag new tasks');
    await collection(page); await page.locator('#edit-' + extensionId).click();
    await studio(page).locator('#studio-view-saved').click();
    const after = review(page).locator('.rs-before-after .rs-task-after');
    await expect(after).toContainText('Tags: next');
    await expect(after).not.toContainText('complete resulting tag list is unknown');

    // A presentation-only compatibility fixture: the real checked run above has
    // tags, but an older/incomplete projection may omit that starting field.
    await page.route('**/api/extensions/*/evidence/*', async route => {
      const response = await route.fetch(), body = await response.json();
      for (const row of body.reports) if (row.report.scenario?.task) delete row.report.scenario.task.tags;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await studio(page).locator('#studio-view-saved').click();
    await expect(after).toContainText('Added tag: next');
    await expect(after).toContainText('Starting tags were not recorded; the complete resulting tag list is unknown.');
    await expect(after).not.toContainText('Tags: next');
    await after.getByText('All example task details', { exact: true }).click();
    await expect(after).not.toContainText('Tags next');
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('collection keeps selected A separate from proposed B and resolves names only for the current owner', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const headers = await signIn(page, fixture), { projectId, otherProjectId, projectName } = fixture.metadata;
    const name = 'My explicit saved check', first = await save(page, fixture, headers, 'TaskBeforeCreate', guardProgram(projectId, otherProjectId), name);
    await collection(page); await page.locator('#edit-' + first.extensionId).click();
    await studio(page).locator('#studio-view-saved').click();
    await turnOn(page, 'TaskBeforeCreate');
    const next = taskCreateGuardFixture({ host: loadHost('TaskBeforeCreate'), rule: 'client-due', projectId, otherProjectId });
    const second = await save(page, fixture, headers, 'TaskBeforeCreate', next, name, 'maya', first.extensionId);
    expect(second.checked.draft.id).not.toBe(first.checked.draft.id);
    await collection(page);
    const card = page.getByRole('article', { name, exact: true });
    const active = card.locator('.customization-behavior').filter({ has: page.getByRole('heading', { name: /^What’s in use:/ }) });
    const proposed = card.locator('.customization-behavior').filter({ has: page.getByRole('heading', { name: /^Proposed changes:/ }) });
    await assertFacts(active, [projectName, 'priority is Normal']);
    await expect(active).not.toContainText('tag “client”');
    await assertFacts(proposed, ['tag “client”', 'no due date']);
    await expect(proposed).not.toContainText('priority is Normal');
    await page.locator('#edit-' + first.extensionId).click();
    await assertFacts(summary(page), ['tag “client”', 'no due date']);
    await collection(page); await assertFacts(active, [projectName, 'priority is Normal']);

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    const missing = await save(page, fixture, headers, 'TaskBeforeCreate', guardProgram('missing-example-project', otherProjectId), 'Unresolved project check');
    await collection(page);
    const missingCard = page.getByRole('article', { name: 'Unresolved project check', exact: true });
    await expect(missingCard).toContainText('chosen project (name unavailable)');
    await expect(missingCard).toContainText('priority is Normal');
    await expect(missingCard).not.toContainText('missing-example-project');
    await page.locator('#edit-' + missing.extensionId).click();
    await expect(summary(page)).toContainText('A full summary of this rule is unavailable.');

    fixture.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=?').run(first.checked.evidence.id);
    await collection(page);
    await expect(card).toContainText('Couldn’t check what’s in use');
    await expect(card.getByRole('heading', { name: /^What’s in use:/ })).toHaveCount(0);
    await assertFacts(proposed, ['tag “client”', 'no due date']);

    const samHeaders = await signIn(page, fixture, 'sam');
    const samProjects = await (await page.request.get(fixture.origin + '/api/projects', { headers: samHeaders })).json();
    const samProject = samProjects[0];
    await save(page, fixture, samHeaders, 'TaskBeforeCreate', guardProgram(samProject.id, 'other-example-project'), 'Sam’s check', 'sam');
    await collection(page);
    const samCard = page.getByRole('article', { name: 'Sam’s check', exact: true });
    await assertFacts(samCard, [samProject.name, 'priority is Normal']);
    await expect(page.getByRole('article', { name, exact: true })).toHaveCount(0);
    await expect(samCard).not.toContainText(projectName);
  } finally { await fixture.close(); }
});

test('unexpected BLOCKED stays a mismatch and never borrows the deliberate failure explanation', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const headers = await signIn(page, fixture), { projectId, otherProjectId } = fixture.metadata;
    const { extensionId, checked } = await save(page, fixture, headers, 'TaskBeforeCreate', guardProgram(projectId, otherProjectId), 'Unexpected check result');
    const saved = fixture.db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(checked.evidence.id);
    const payload = JSON.parse(saved.payload), allowed = payload.reports.find(item => item.id.endsWith('-matching-allow'));
    const unavailable = payload.reports.find(item => item.id.endsWith('-unavailable'));
    allowed.report.consumption = { status: 'BLOCKED' };
    allowed.report.native = structuredClone(unavailable.report.native);
    fixture.db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run(JSON.stringify(payload), checked.evidence.id);
    await collection(page); await page.locator('#edit-' + extensionId).click();
    await studio(page).locator('#studio-view-saved').click();
    const wrong = review(page).getByRole('article', { name: 'Example: New task example 1', exact: true });
    await expect(wrong).toContainText('Needs another check');
    await expect(wrong).not.toContainText('This example deliberately');
    await expect(wrong).not.toContainText('Saving stopped as expected');
    await expect(review(page).getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
    expect(fixture.db.prepare('SELECT count(*) AS n FROM extension_approvals WHERE owner_id=? AND revision_id=?').get('maya', checked.draft.id).n).toBe(0);
  } finally { await fixture.close(); }
});
