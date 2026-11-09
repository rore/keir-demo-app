import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { loadHost } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCreateGuardFixture } from '../fixtures/task-create-guard.mjs';

test.use({ timezoneId: 'UTC' });
const owner = 'maya', correctedDueTime = '2027-03-06T16:00';
const dialog = page => page.getByRole('dialog', { name: 'New task', exact: true });
const fields = page => ({ title: dialog(page).getByLabel('Task title', { exact: true }),
  notes: dialog(page).getByLabel('Notes (optional)', { exact: true }), tags: dialog(page).getByLabel('Tags', { exact: true }),
  priority: dialog(page).getByLabel('Priority', { exact: true }), dueTime: dialog(page).getByLabel('Due time (optional)', { exact: true }) });

async function selectProject(page, name) {
  const select = page.getByLabel('Project', { exact: true });
  if (await select.isVisible()) await select.selectOption({ label: name });
  else await page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function fill(page, draft) {
  for (const [key, value] of Object.entries(draft)) {
    if (key === 'priority') await fields(page)[key].selectOption(value);
    else await fields(page)[key].fill(value);
  }
}

async function retained(page, draft) {
  for (const [key, value] of Object.entries(draft)) await expect(fields(page)[key]).toHaveValue(value);
  await expect(dialog(page).locator('[aria-invalid="true"]')).toHaveCount(0);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function submit(page) {
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/tasks');
  await dialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
  return response;
}

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, narrow: { width: 320, height: 740 }, short: { width: 683, height: 384 } })) {
  for (const rule of ['client-due', 'priority-note', 'project-review']) {
    test(`real ${rule} review and native correction on ${layout}`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      const fixture = await startAuthoringFixture({ unconfigured: true });
      try {
        await page.setViewportSize(viewport);
        await page.goto(fixture.origin);
        await page.getByRole('button', { name: /^Continue as Maya/ }).click();
        await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue(owner);
        const session = await (await page.request.get(fixture.origin + '/api/session')).json();
        const headers = { origin: fixture.origin, 'X-Session-Context': session.contextToken };
        const catalogResponse = await page.request.get(fixture.origin + '/api/extensions/catalog', { headers });
        expect(catalogResponse.ok(), await catalogResponse.text()).toBe(true);
        const catalog = await catalogResponse.json(), host = loadHost('TaskBeforeCreate');
        expect(catalog.hooks.find(hook => hook.id === 'TaskBeforeCreate')).toMatchObject({ effect: 'READ', trigger: 'REQUEST' });
        expect(catalog.model.digest).toBe(host.pins.modelDigest);
        expect(JSON.parse(catalog.model.dcm).entrypoints.TaskBeforeCreate).toMatchObject({ trigger: 'REQUEST', placement: 'BEFORE_COMMIT', consumer: { kind: 'DECISION' } });
        const { projectId, otherProjectId, projectName, otherProjectName } = fixture.metadata;
        const program = taskCreateGuardFixture({ host, rule, projectId, otherProjectId });
        const counts = () => ['tasks', 'task_events', 'task_create_operations', 'task_effect_receipts']
          .map(table => fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
        const afterEvents = () => fixture.db.prepare("SELECT * FROM extension_selections WHERE owner_id=? AND hook_id IN ('TaskCreated','TaskCompleted') ORDER BY hook_id").all(owner);
        const originalEvents = afterEvents(), originalCounts = counts();
        const selected = () => fixture.db.prepare("SELECT * FROM extension_selections WHERE owner_id=? AND hook_id='TaskBeforeCreate'").get(owner);
        const originalSelection = selected();
        const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { owner, name: rule + ' check' });
        const write = async (action, data) => {
          const response = await page.request.post(`${fixture.origin}/api/extensions/${extensionId}/${action}`, { headers, data });
          expect(response.ok(), await response.text()).toBe(true); return response.json();
        };
        const compiled = await write('compile', { hookId: 'TaskBeforeCreate', source: program.source, draftVersion: 0 });
        expect(compiled.draft.pins.compiler).toBe('keir-compiler-java/0.3.0');
        const saved = await write('scenarios', { revisionId: compiled.draft.id, draftVersion: compiled.draftVersion, cases: program.cases });
        const checked = await write('simulate', { revisionId: saved.draft.id, draftVersion: saved.draftVersion });
        expect(checked.evidence.passed).toBe(true);
        expect(checked.evidence.revisionId).toBe(checked.draft.id);
        const evidenceResponse = await page.request.get(`${fixture.origin}/api/extensions/${extensionId}/evidence/${checked.evidence.id}`, { headers });
        expect(evidenceResponse.ok(), await evidenceResponse.text()).toBe(true);
        const evidence = await evidenceResponse.json();
        expect(evidence.reports).toHaveLength(4);
        expect(evidence.reports.every(item => item.report.status === 'PASS')).toBe(true);
        expect(evidence.reports.find(item => item.id.endsWith('-unavailable')).report.consumption).toEqual({ status: 'BLOCKED' });
        expect(counts()).toEqual(originalCounts);
        expect(selected()).toEqual(originalSelection);

        await page.goto(`${fixture.origin}/#customization=${extensionId}`);
        const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
        const about = studio.getByRole('article', { name: 'About this rule', exact: true });
        await expect(studio.getByLabel('Customization status')).toContainText('Checks before adding');
        await expect(about).toContainText('Before a new task is saved.');
        await expect(about).toContainText('This rule can stop a new task from being added.');
        await expect(about).toContainText('See the checked examples and exact saved rule for its requirements.');
        await about.getByRole('button', { name: 'View simulation', exact: true }).click();
        const review = studio.getByRole('article', { name: 'Current decision', exact: true });
        await expect(review.getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
        await expect(review).toContainText('Sample tasks only · no tasks are saved');
        const example = id => review.getByRole('article', { name: `Example: New task example ${evidence.reports.findIndex(item => item.id === id) + 1}`, exact: true });
        await expect(example(`${rule}-matching-deny`)).toContainText(program.metadata.message);
        await expect(review.getByRole('heading', { name: `${rule}-matching-deny`, exact: true })).toHaveCount(0);
        await expect(review.getByLabel('Exact checked examples', { exact: true })).toContainText(`${rule}-matching-deny`);
        const unavailableExample = example(`${rule}-unavailable`);
        await expect(unavailableExample).toContainText('Could not check');
        await expect(unavailableExample.getByText('Handled as expected', { exact: true })).toBeVisible();
        await expect(review).not.toContainText('Needs another check');
        expect(await studio.locator('.rs-messages').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await unavailableExample.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${rule}-${layout}-simulation.png`) });
        const use = review.getByRole('button', { name: 'Turn on for new tasks', exact: true });
        await expect(use).toHaveCount(0);
        await review.getByRole('button', { name: 'Approve this change', exact: true }).click();
        await expect(use).toBeFocused();
        await expect(review).toContainText('Approved · Still off');
        expect(selected()).toEqual(originalSelection);
        expect(afterEvents()).toEqual(originalEvents);
        expect(fixture.db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, checked.draft.id).evidence_id).toBe(checked.evidence.id);
        await use.click();
        await expect(studio.getByLabel('Customization status')).toContainText('On for new tasks');
        await expect(studio.locator('#studio-use-confirmed')).toBeFocused();
        expect(selected().revision_id).toBe(checked.draft.id);
        expect(selected().generation).toBe(originalSelection.generation + 1);
        expect(afterEvents()).toEqual(originalEvents);
        expect(counts()).toEqual(originalCounts);
        await studio.getByRole('button', { name: 'Back to tasks', exact: true }).click();
        await selectProject(page, projectName);

        const draft = { title: `${rule} ${layout} corrected task`, notes: rule === 'priority-note' ? ' \t ' : 'Keep these submitted notes.',
          tags: rule === 'client-due' ? ' Client, internal, CLIENT ' : 'client, internal',
          priority: rule === 'priority-note' ? 'high' : 'normal', dueTime: rule === 'client-due' ? '' : correctedDueTime };
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        await expect(fields(page).title).toBeFocused();
        await fill(page, draft);
        const denial = await submit(page);
        expect(denial.status(), await denial.text()).toBe(422);
        const deniedResult = await denial.json();
        expect(deniedResult).toMatchObject({ state: 'NOT_CREATED', code: 'RULE_DENIED', message: program.metadata.message });
        const alert = dialog(page).getByRole('alert');
        await expect(alert).toHaveText('Not added. ' + program.metadata.message);
        await expect(alert).toBeFocused();
        await expect(alert).toBeInViewport();
        await expect(alert.locator('a, button, input')).toHaveCount(0);
        await retained(page, draft);
        expect(counts()).toEqual([originalCounts[0], originalCounts[1], originalCounts[2] + 1, originalCounts[3]]);
        const deniedRow = fixture.db.prepare('SELECT * FROM task_create_operations WHERE owner_id=? AND operation_id=?').get(owner, deniedResult.operationId);
        expect(JSON.parse(Buffer.from(deniedRow.candidate))).toMatchObject({ projectId, title: draft.title, notes: draft.notes, tags: ['client', 'internal'], priority: draft.priority });
        await page.screenshot({ path: testInfo.outputPath(`${rule}-${layout}-denied.png`) });

        const correction = rule === 'client-due' ? { dueTime: correctedDueTime } : rule === 'priority-note' ? { notes: 'Correction note.' } : { tags: draft.tags + ', Review' };
        await fill(page, correction);
        const success = await submit(page);
        expect(success.status(), await success.text()).toBe(201);
        const task = await success.json();
        await expect(dialog(page)).not.toBeVisible();
        await expect(page.locator('.task-open').filter({ hasText: draft.title })).toBeVisible();
        expect(task).toMatchObject({ projectId, title: draft.title, notes: correction.notes ?? draft.notes, priority: draft.priority,
          tags: rule === 'project-review' ? ['client', 'internal', 'review'] : ['client', 'internal'], dueAt: '2027-03-06T16:00:00.000Z' });
        expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks WHERE owner_id=? AND title=?').get(owner, draft.title).n).toBe(1);
        expect(counts()).toEqual([originalCounts[0] + 1, originalCounts[1] + 1, originalCounts[2] + 2, originalCounts[3]]);

        if (rule === 'project-review') await selectProject(page, otherProjectName);
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        await fill(page, { title: `${rule} ${layout} nonmatch`, notes: '', tags: 'internal', priority: rule === 'priority-note' ? 'low' : 'normal', dueTime: '' });
        const nonmatch = await submit(page);
        expect(nonmatch.status(), await nonmatch.text()).toBe(201);
        expect((await nonmatch.json()).projectId).toBe(rule === 'project-review' ? otherProjectId : projectId);
        await expect(dialog(page)).not.toBeVisible();
        expect(counts()).toEqual([originalCounts[0] + 2, originalCounts[1] + 2, originalCounts[2] + 3, originalCounts[3]]);

        await selectProject(page, projectName);
        fixture.db.prepare('UPDATE extension_evidence SET passed=0 WHERE id=? AND owner_id=?').run(checked.evidence.id, owner);
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        const unavailableDraft = { ...draft, ...correction, title: `${rule} ${layout} unavailable` };
        await fill(page, unavailableDraft);
        const failure = await submit(page);
        expect(failure.status(), await failure.text()).toBe(503);
        expect(await failure.json()).toMatchObject({ state: 'NOT_CREATED', code: 'CHECK_UNAVAILABLE' });
        await expect(alert).toContainText('could not be checked');
        await expect(alert).not.toContainText(program.metadata.message);
        await expect(alert).toBeFocused();
        await expect(alert.locator('a, button, input')).toHaveCount(0);
        await retained(page, unavailableDraft);
        expect(counts()).toEqual([originalCounts[0] + 2, originalCounts[1] + 2, originalCounts[2] + 4, originalCounts[3]]);
        expect(afterEvents()).toEqual(originalEvents);
        expect(fixture.requests).toHaveLength(0);
        await page.screenshot({ path: testInfo.outputPath(`${rule}-${layout}-unavailable.png`) });
      } finally { await fixture.close(); }
    });
  }
}
