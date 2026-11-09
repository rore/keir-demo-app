import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { loadHost } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskWorkflowCases, taskWorkflowSource } from '../fixtures/task-workflow-source.mjs';

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

test('Studio reads the four admitted rules from pinned source and falls back after a changed readback', async ({ page }, testInfo) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const rule = studio.getByRole('article', { name: 'About this rule', exact: true });
    const { projectId, otherProjectId: destinationProjectId, projectName, otherProjectName } = fixture.metadata;
    const rows = [
      ['intake', 'TaskCreated', 1440, [`All of these apply: this task is in “${projectName}”`, 'titled exactly “Quote for spring launch”', 'tag “client”', 'Priority High.'], 'No change. This task’s title isn’t exactly “Quote for spring launch”.'],
      ['review', 'TaskCompleted', 1440, ['this task has High priority', 'tag “review”', `Create a task titled “Review” in “${otherProjectName}”`, 'Tags review, next.', 'Due 168 hours after completion.'], 'No change. The rule requires High priority.'],
      ['follow-up', 'TaskCompleted', 390, [`“${otherProjectName}” has no open task titled exactly “Follow-up”`], 'No task was created because an open task matched.'],
      ['onboarding', 'TaskCreated', 320, ['this task has no due date', 'Due 168 hours after addition.'], 'No change. This task already has a due date.'],
    ];
    for (const [workflow, hookId, width, facts, noChangeReason] of rows) {
      await page.setViewportSize({ width, height: 844 });
      const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: workflow });
      const host = loadHost(hookId), options = { projectId, destinationProjectId };
      const source = taskWorkflowSource(host, workflow, options).toString();
      const write = async (action, data) => {
        const response = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/${action}`, {
          headers: { origin: fixture.origin, 'X-Session-Context': contextToken }, data,
        });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const { draft, draftVersion } = await write('compile', { hookId, source, draftVersion: 0 });
      const saved = await write('scenarios', { revisionId: draft.id, draftVersion, cases: taskWorkflowCases(host, workflow, options) });
      const checked = await write('simulate', { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
      expect(checked.evidence.passed).toBe(true);
      await page.goto(`${fixture.origin}/#customization=${extensionId}`);
      for (const fact of facts) await expect(rule).toContainText(fact);
      await expect(rule).not.toContainText('A full summary isn’t available');
      await rule.getByRole('button', { name: 'View simulation', exact: true }).click();
      const review = studio.getByRole('article', { name: 'Current decision' });
      if (noChangeReason) await expect(review).toContainText(noChangeReason);
      if (workflow === 'follow-up') {
        await expect(review).not.toContainText('A matching open task was found.');
        await expect(review).toContainText('Could not check for a matching open task.');
      }
      if (workflow === 'onboarding') await expect(review).toContainText('Event 2026-03-07 16:00:00.417 UTC');
      expect(await studio.locator('.rs-messages').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (noChangeReason) {
        await review.getByText(noChangeReason).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${workflow}-${width}.png`) });
      }
      if (workflow === 'onboarding') {
        await page.route(`**/api/extensions/${extensionId}/revisions/${checked.draft.id}`, async route => {
          const exact = await route.fetch(), saved = await exact.json();
          await route.fulfill({ response: exact, json: { ...saved, source: saved.source.replace('604800s', '60s') } });
        });
        await page.reload();
        await expect(rule).toContainText('A full summary isn’t available for this version.');
        await expect(rule).toContainText('The saved conditions can’t be summarized here.');
        await expect(rule).not.toContainText('168 hours');
      }
    }
  } finally { await fixture.close(); }
});

test('Studio summarizes the current YAML follow-up and keeps forged or unsupported summaries conservative', async ({ page }, testInfo) => {
  const captured = JSON.parse(readFileSync(new URL('../fixtures/task-follow-up-summary.json', import.meta.url)));
  const currentHost = loadHost('TaskCompleted'), originalArtifact = JSON.parse(captured.artifact);
  const currentSource = captured.source.replace("version: '4'", "version: '5'")
    .replace(originalArtifact.modelRef.digest, currentHost.pins.modelDigest);
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Follow-up in the same project' });
    const compiled = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/compile`, {
      headers: { origin: fixture.origin, 'X-Session-Context': contextToken },
      data: { hookId: 'TaskCompleted', source: currentSource, draftVersion: 0 },
    });
    expect(compiled.ok(), await compiled.text()).toBe(true);
    const state = await compiled.json();
    expect(state.draft.pins.modelRef.format).toBe('keir-dcm/3');
    expect(state.draft.pins.artifactDigest).not.toBe(captured.pins.artifactDigest);
    expect(state.draft.pins.rawSourceDigest).toBe('sha256:' + createHash('sha256').update(currentSource).digest('hex'));
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const rule = studio.getByRole('article', { name: 'About this rule', exact: true });
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.origin}/#customization=${extensionId}`);
      await expect(rule.getByText('this task is completed.', { exact: true })).toBeVisible();
      await expect(rule).toContainText('Create a task with this task’s title followed by “ - follow up” in this task’s project.');
      await expect(rule).not.toContainText('A full summary isn’t available');
      expect(await studio.locator('.rs-messages').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(studio.getByLabel('Message to Daymark assistant', { exact: true })).toBeInViewport();
      await rule.screenshot({ path: testInfo.outputPath(`same-project-follow-up-${width}.png`) });
    }
    const path = `**/api/extensions/${extensionId}/revisions/${state.draft.id}`;
    for (const forge of [
      saved => ({ ...saved, artifact: saved.artifact + ' ' }),
      saved => ({ ...saved, source: saved.source + '\n' }),
      saved => ({ ...saved, pins: { ...saved.pins, compiledSourceDigest: 'sha256:' + '0'.repeat(64) } }),
    ]) {
      await page.route(path, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: forge(await response.json()) });
      });
      await page.reload();
      await expect(rule).toContainText('A full summary isn’t available for this version.');
      await expect(rule).not.toContainText('followed by');
      await page.unroute(path);
    }
    const unsupported = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/compile`, {
      headers: { origin: fixture.origin, 'X-Session-Context': contextToken },
      data: { hookId: 'TaskCompleted', source: currentSource.replace('source.status ==', 'source.status !='), draftVersion: state.draftVersion },
    });
    expect(unsupported.ok(), await unsupported.text()).toBe(true);
    await page.reload();
    await expect(rule).toContainText('The saved conditions can’t be summarized here.');
    await expect(rule).not.toContainText('this task is completed');
  } finally { await fixture.close(); }
});

test('workflow review keeps native outcomes and the two decisions distinct', async ({ page }, testInfo) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const actions = [];
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const { user: owner } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const extension = { id: 'new-rule', name: 'Intake priority', hookId: 'TaskCreated' };
    const artifact = JSON.stringify({ format: 'keir-artifact/2', entrypoint: extension.hookId,
      steps: [{ id: 'set-priority', op: 'CALL', capability: 'tasks.update', when: 'eligible', args: { priority: { literal: 'high' } } }] });
    const pins = { artifactDigest: `sha256:${createHash('sha256').update(artifact).digest('hex')}` };
    const draft = { id: 'intake-revision', label: extension.name, kind: 'authored', suiteDigest: 'suite', pins, provenance: 'customer' };
    const prior = { ...draft, id: 'prior-intake-revision', extensionId: 'prior-intake', extensionName: 'Existing intake rule' };
    const completion = { ...prior, extensionId: 'review-rule', extensionName: 'Completion review rule' };
    const picked = (revision, generation) => ({ revision, generation, eligible: true, approvedEvidenceId: 'prior-proof' });
    const evidence = { id: 'proof', revisionId: draft.id, passed: true };
    let state = { owner, extension, draft, draftVersion: 2, selection: picked(prior, 7), evidence, approved: false, approvedEvidenceId: null,
      catalog: [], restoreTargets: [], history: [], evidenceHistory: [] };
    const baseTask = { id: 'example', title: 'Quote for spring launch', status: 'OPEN', priority: 'normal', projectId: fixture.metadata.projectId };
    const read = { capability: 'tasks.get' }, update = { capability: 'tasks.update', step: 'set-priority' };
    const dueAt = '2026-03-07T16:00:00.417Z';
    const unchanged = { id: baseTask.id, priority: 'high', dueAt, addTag: 'client' };
    const cases = [
      ['updated', baseTask, 'CONFIRMED', [{ id: baseTask.id, priority: 'high' }], [read, update]],
      ['unchanged-write', { ...baseTask, title: 'Already current', priority: 'high', tags: ['client'], dueAt }, 'CONFIRMED', [unchanged], [read, update]],
      ['unknown-before', { id: baseTask.id, title: 'Before snapshot unavailable' }, 'CONFIRMED', [unchanged], [update]],
      ['untouched', { ...baseTask, title: 'Quote for autumn launch' }, 'NONE', [], [read]],
      ['read-failed', { id: baseTask.id, title: 'Example task' }, 'NONE', [], [read], { code: 'ACCESS_DENIED' }],
      ['uncertain', { ...baseTask, title: 'Priority change unconfirmed' }, 'UNKNOWN', null, [read, update]],
    ].map(([id, task, effect, updatedTasks, calls, error]) => {
      const changes = { createdTasks: effect === 'UNKNOWN' ? null : [], updatedTasks };
      return { id, expected: changes, report: { status: 'PASS', scenario: { task }, native: { error }, calls, observed: { effect, ...changes } } };
    });
    const check = (step, title) => ({ step, capability: 'tasks.openMatch', args: { title, projectId: fixture.metadata.projectId } });
    const checks = [check('first', 'Follow-up'), check('second', 'Other follow-up'), check('third', 'Follow-up')];
    const noWrite = { createdTasks: [], updatedTasks: [] };
    cases.push({ id: 'three-checks', expected: noWrite, report: { status: 'PASS', calls: checks,
      native: { error: { code: 'ADAPTER_TRANSIENT' }, trace: checks.slice(0, 2).map(({ step, capability }) => ({ event: 'CALL_SUCCEEDED', step, capability })) },
      scenario: { task: { ...baseTask, title: 'Three lookup results' }, openMatches: [
        { ...checks[0].args, matches: true }, { ...checks[1].args, matches: false },
      ] }, observed: { effect: 'NONE', ...noWrite } } });
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
    const idempotent = review.getByRole('article', { name: /Already current/ });
    await expect(idempotent).toContainText('Update confirmed. The task fields stayed the same.');
    await expect(idempotent).not.toContainText('→');
    const unknownBefore = review.getByRole('article', { name: /Before snapshot unavailable/ });
    await expect(unknownBefore.getByText('Update confirmed.', { exact: true })).toBeVisible();
    await expect(unknownBefore).not.toContainText('→');
    const lookups = review.getByRole('article', { name: /Three lookup results/ });
    const results = lookups.locator('p').filter({ hasText: /^Open-task check/ });
    await expect(results).toHaveCount(3);
    await expect(results.nth(0)).toContainText(/exact title “Follow-up”.*\. A matching open task was found\./);
    await expect(results.nth(1)).toContainText(/exact title “Other follow-up”.*No matching open task was found\./);
    await expect(results.nth(2)).toContainText(/exact title “Follow-up”.*Could not check for a matching open task\./);
    await expect(lookups.getByText('Could not check', { exact: true })).toBeVisible();
    await expect(lookups.getByText('Handled as expected', { exact: true })).toBeVisible();
    await expect(lookups).not.toContainText('because an open task matched');
    await expect(review.getByRole('article', { name: /autumn launch/ })).toContainText('No change.');
    await expect(review.getByText('The task could not be checked because access was denied.')).toBeVisible();
    const uncertain = review.getByRole('article', { name: /Priority change unconfirmed/ });
    await expect(uncertain.getByText('Change not confirmed', { exact: true })).toBeVisible();
    await expect(uncertain.getByText('Handled as expected', { exact: true })).toBeVisible();
    await expect(uncertain).toContainText('We could not confirm whether the priority changed.');
    await lookups.screenshot({ path: testInfo.outputPath('unavailable-workflow-row.png') });
    await uncertain.screenshot({ path: testInfo.outputPath('uncertain-workflow-row.png') });
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
