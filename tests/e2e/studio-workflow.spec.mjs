import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { loadHost } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskWorkflowSource } from '../fixtures/task-workflow-source.mjs';

test('workflow starters are capability gated and preserve the mounted composer at 320px', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const turns = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/authoring/turn') turns.push(request);
  });
  try {
    await page.setViewportSize({ width: 320, height: 740 });
    let openMatch = false;
    await page.route('**/api/extensions/catalog', route => route.fulfill({ json: {
      hooks: [{ id: 'TaskCreated', label: 'Task added', description: 'After a task is added' },
        { id: 'TaskCompleted', label: 'Task completed', description: 'After a task is completed' }],
      model: { digest: 'sha256:fixture', dcm: JSON.stringify({ capabilities: {
        'tasks.get': {}, 'tasks.create': {}, 'tasks.update': {}, ...(openMatch && { 'tasks.openMatch': {} }),
      } }) },
    } }));
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('combobox', { name: 'Destination', exact: true }).selectOption({ label: 'Customizations' });
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const composer = studio.getByLabel('Message to Daymark assistant', { exact: true });
    await expect(studio.getByRole('heading', { name: 'What would you like Daymark to do for you?' })).toBeVisible();
    await expect(studio.getByRole('button', { name: 'Avoid another follow-up' })).toHaveCount(0);
    await expect(studio.getByRole('button', { name: 'Arrange a review' })).toBeVisible();
    await expect(studio.getByRole('button', { name: 'Add missing due dates' })).toBeVisible();

    const intake = studio.getByRole('button', { name: 'Prioritize new requests' });
    await intake.focus();
    await page.keyboard.press('Enter');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(/title is exactly .*Quote for spring launch/);
    await composer.fill(' Keep this unsent text. ');
    await studio.getByRole('button', { name: 'Arrange a review' }).click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(' Keep this unsent text. ');
    await expect(studio.getByText('Clear your draft before choosing another starting point.')).toBeVisible();
    expect(await studio.locator('.rs-messages').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(turns).toHaveLength(0);

    openMatch = true;
    await page.reload();
    await expect(studio.getByRole('button', { name: 'Avoid another follow-up' })).toBeVisible();
  } finally { await fixture.close(); }
});

test('Studio reads the four admitted rules from pinned source and falls back after a changed readback', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const rule = studio.getByRole('article', { name: 'About this rule', exact: true });
    const { projectId, otherProjectId: destinationProjectId, projectName, otherProjectName } = fixture.metadata;
    const rows = [
      ['intake', 'TaskCreated', [`All of these apply: this task is in “${projectName}”`, 'titled exactly “Quote for spring launch”', 'tag “client”', 'Priority High.']],
      ['review', 'TaskCompleted', ['this task has High priority', 'tag “review”', `in “${otherProjectName}”`, 'Due 168 hours after completion.']],
      ['follow-up', 'TaskCompleted', [`“${otherProjectName}” has no open task titled exactly “Follow-up”`]],
      ['onboarding', 'TaskCreated', ['this task has no due date', 'Due 168 hours after addition.']],
    ];
    for (const [workflow, hookId, facts] of rows) {
      const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: workflow });
      const source = taskWorkflowSource(loadHost(hookId), workflow, { projectId, destinationProjectId }).toString();
      const response = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/compile`, {
        headers: { origin: fixture.origin, 'X-Session-Context': contextToken }, data: { hookId, source, draftVersion: 0 },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const { draft } = await response.json();
      await page.goto(`${fixture.origin}/#customization=${extensionId}`);
      for (const fact of facts) await expect(rule).toContainText(fact);
      await expect(rule).not.toContainText('A full summary isn’t available');
      if (workflow === 'onboarding') {
        await page.route(`**/api/extensions/${extensionId}/revisions/${draft.id}`, async route => {
          const exact = await route.fetch(), saved = await exact.json();
          await route.fulfill({ response: exact, json: { ...saved, source: saved.source.replace('604800s', '60s') } });
        });
        await page.reload();
        await expect(rule).toContainText('The saved conditions can’t be summarized here.');
        await expect(rule).not.toContainText('168 hours');
      }
    }
  } finally { await fixture.close(); }
});

test('workflow review keeps native outcomes and the two decisions distinct', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const actions = [];
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    const { user: owner } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const extension = { id: 'new-rule', name: 'Intake priority', hookId: 'TaskCreated' };
    const artifact = JSON.stringify({ format: 'keir-artifact/2', entrypoint: extension.hookId,
      steps: [{ op: 'CALL', capability: 'tasks.update', when: 'eligible', args: { priority: { literal: 'high' } } }] });
    const pins = { artifactDigest: `sha256:${createHash('sha256').update(artifact).digest('hex')}` };
    const draft = { id: 'intake-revision', label: extension.name, kind: 'authored', suiteDigest: 'suite', pins, provenance: 'customer' };
    const prior = { ...draft, id: 'prior-intake-revision', extensionId: 'prior-intake', extensionName: 'Existing intake rule' };
    const completion = { ...prior, extensionId: 'review-rule', extensionName: 'Completion review rule' };
    const picked = (revision, generation) => ({ revision, generation, eligible: true, approvedEvidenceId: 'prior-proof' });
    const evidence = { id: 'proof', revisionId: draft.id, passed: true };
    let state = { owner, extension, draft, draftVersion: 2, selection: picked(prior, 7), evidence, approved: false, approvedEvidenceId: null,
      catalog: [], restoreTargets: [], history: [], evidenceHistory: [] };
    const baseTask = { id: 'example', title: 'Quote for spring launch', status: 'OPEN', priority: 'normal', projectId: fixture.metadata.projectId };
    const read = { capability: 'tasks.get' }, update = { capability: 'tasks.update' };
    const cases = [
      ['updated', baseTask, 'CONFIRMED', [{ id: baseTask.id, priority: 'high' }], [read, update]],
      ['untouched', { ...baseTask, title: 'Quote for autumn launch' }, 'NONE', [], [read]],
      ['read-failed', { id: baseTask.id, title: 'Example task' }, 'NONE', [], [read], { code: 'ACCESS_DENIED' }],
      ['uncertain', baseTask, 'UNKNOWN', null, [read, update]],
    ].map(([id, task, effect, updatedTasks, calls, error]) => {
      const changes = { createdTasks: effect === 'UNKNOWN' ? null : [], updatedTasks };
      return { id, expected: changes, report: { status: 'PASS', scenario: { task }, native: { error }, calls, observed: { effect, ...changes } } };
    });
    await page.route('**/api/extensions', route => route.fulfill({ json: { owner, items: [state, { ...state, draft: completion,
      extension: { id: completion.extensionId, name: completion.extensionName, hookId: 'TaskCompleted' } }], selection: picked(completion, 10),
      selections: { TaskCreated: state.selection, TaskCompleted: picked(completion, 10) }, catalog: [], next: null } }));
    await page.route('**/api/extensions/new-rule', route => route.fulfill({ json: state }));
    await page.route('**/api/extensions/new-rule/evidence/proof', route => route.fulfill({ json: { ...evidence, identity: {}, reports: cases } }));
    await page.route('**/api/extensions/new-rule/revisions/intake-revision', route => route.fulfill({ json: {
      extensionId: extension.id, revisionId: draft.id, suiteDigest: draft.suiteDigest, artifact, pins, source: 'sample source', cases: ['sample case'],
    } }));
    await page.route('**/api/authoring?extensionId=new-rule', route => route.fulfill({ json: { current: null,
      availability: { available: true, code: null, provider: null, model: null } } }));
    await page.route('**/api/extensions/new-rule/approve', route => {
      actions.push('approve');
      state = { ...state, approved: true, approvedEvidenceId: evidence.id };
      return route.fulfill({ json: state });
    });
    await page.route('**/api/extensions/new-rule/activate', route => {
      actions.push(route.request().postDataJSON());
      state = { ...state, selection: { ...picked({ ...draft, extensionId: extension.id, extensionName: extension.name }, 8), approvedEvidenceId: evidence.id } };
      return route.fulfill({ json: state });
    });

    await nav.getByRole('button', { name: 'Customizations', exact: true }).click();
    await expect(page.getByRole('article', { name: completion.extensionName })).toContainText('In use');
    await page.getByRole('article', { name: extension.name }).getByRole('button', { name: 'Continue changes' }).click();
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    await expect(studio.getByLabel('Customization status')).toContainText('For tasks added · Currently on: Existing intake rule');
    await expect(studio.getByRole('article', { name: 'About this rule' })).toContainText('Update this task. Priority High.');
    await studio.getByRole('button', { name: 'View simulation', exact: true }).click();
    const review = studio.getByRole('article', { name: 'Current decision' });
    await expect(review.getByText('Updated this task. Priority Normal → High.')).toBeVisible();
    await expect(review.getByRole('article', { name: /autumn launch/ })).toContainText('No change.');
    await expect(review.getByText('The task could not be checked because access was denied.')).toBeVisible();
    await expect(review.getByText('Matches expected uncertainty · Change not confirmed')).toBeVisible();
    const use = review.getByRole('button', { name: 'Turn on for tasks added', exact: true });
    await expect(use).toHaveCount(0);
    await review.getByRole('button', { name: 'Approve this change', exact: true }).click();
    await expect(use).toBeFocused();
    await expect(review.getByText(/This replaces “Existing intake rule” for this trigger/)).toBeVisible();
    expect(actions).toEqual(['approve']);
    await use.click();
    await expect(studio.getByLabel('Customization status')).toContainText('Currently on: Intake priority');
    expect(actions[1]).toMatchObject({ generation: 7, revisionId: draft.id, evidenceId: evidence.id });
  } finally { await fixture.close(); }
});
