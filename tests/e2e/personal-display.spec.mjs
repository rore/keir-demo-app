import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { navigate } from '../fixtures/workspace-ui.mjs';
import { openSavedChanges } from '../fixtures/studio-review.mjs';

test.use({ hasTouch: true, timezoneId: 'America/New_York', locale: 'en-US' });

for (const width of [390, 1440]) test(`Personal examples and completed tasks at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { projectId, otherProjectId, projectName, otherProjectName } = fixture.metadata;
    const title = 'Send the customer a follow-up';
    const program = taskCustomizationFixture({ projectId, otherProjectId, title });
    const source = JSON.parse(program.source);
    source.steps[3].args.dueAt = { cel: 'input.occurredAt + duration("604800s")' };
    const [match, nonmatch, , , , unavailable] = program.cases.map(JSON.parse);
    const exactDue = '2026-03-14T12:34:56.789Z';
    for (const call of [match.stubs.at(-1), match.expect.calls.at(-1)]) call.args.dueAt = exactDue;
    const reject = structuredClone(match), effect = { step: 'created', capability: 'tasks.create', state: 'NONE' };
    reject.id = 'creation-rejected';
    reject.stubs.at(-1).response = { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' };
    const result = { classification: 'BUSINESS_REJECTION', error: { code: 'TASK_INVALID', path: '/steps/3' }, effects: [effect] };
    const trace = [...match.expect.outcome.trace.slice(0, 12),
      { sequence: 12, event: 'EFFECT_RECORDED', ...effect }, { sequence: 13, event: 'TERMINATED', code: 'TASK_INVALID' }];
    reject.expect.outcome = { ...result, trace };
    reject.expect.consumption = { status: 'REPORTED', ...result };
    const lifecycle = createLifecycle(fixture.db);
    const { extensionId } = admitTaskDraft(fixture.db, lifecycle, { name: 'Customer follow-up' });

    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).tap();
    await expect(page.locator('.user-tools button[aria-pressed="true"]')).toHaveAttribute('value', 'maya');
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const headers = { origin: fixture.origin, 'X-Session-Context': contextToken };
    const path = `/api/extensions/${extensionId}`;
    async function prepare(action, data) {
      const response = await page.request.post(`${fixture.origin}${path}/${action}`, { headers, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    }
    let draft = await prepare('compile', { hookId: 'TaskCompleted', source: JSON.stringify(source), draftVersion: 0 });
    draft = await prepare('scenarios', { revisionId: draft.draft.id, draftVersion: draft.draftVersion,
      cases: [match, nonmatch, unavailable, reject].map(row => JSON.stringify(row)) });
    const checked = await prepare('simulate', { revisionId: draft.draft.id, draftVersion: draft.draftVersion });
    expect(checked.evidence.passed).toBe(true);
    await page.goto(`${fixture.origin}/#customization=${extensionId}`);
    await openSavedChanges(page, false);
    const review = page.getByRole('article', { name: 'Current decision', exact: true });
    const examples = review.getByRole('region', { name: 'Checked proposed behavior' });
    await expect(examples.getByRole('article')).toHaveCount(4);
    const capture = async (anchor, name) => {
      await anchor.scrollIntoViewIfNeeded();
      await expect(anchor).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), animations: 'disabled' });
    };
    await examples.getByRole('article').first().locator('summary').tap();
    const positive = examples.getByRole('article').first();
    await expect(positive).toContainText('Mar 14, 2026, 12:34 PM UTC');
    await capture(positive.getByText('What happened', { exact: true }), 'example-created');
    const failedCases = examples.getByRole('article').nth(2);
    await failedCases.locator('summary').tap();
    await expect(failedCases).toContainText('The task was temporarily unavailable.');
    await expect(examples.getByRole('article').last()).toContainText('Daymark couldn’t add the new task.');
    await capture(examples.getByText('No task added, as expected', { exact: true }), 'example-failures');
    expect(await examples.innerText()).not.toMatch(/56\.789|deliberately|write could not|handled a simulated problem|Technical details/);
    await expect(examples.getByText('Exact scenario and results', { exact: true })).toHaveCount(0);
    const proof = review.getByLabel('Exact checked examples');
    await expect(proof).toBeHidden();
    await review.getByText('Advanced: saved evidence', { exact: true }).tap();
    await expect(proof).toContainText(exactDue);
    await expect(proof).toContainText('"TASK_INVALID"');
    await review.getByText('Advanced: saved evidence', { exact: true }).tap();
    await review.getByRole('button', { name: 'Approve this change', exact: true }).tap();
    await page.getByRole('button', { name: 'Turn on for tasks completed', exact: true }).tap();
    await expect(page.getByLabel('Customization status')).toContainText('On for my tasks');
    await navigate(page, 'Tasks');

    async function addAndComplete(projectName, taskTitle) {
      const projects = page.getByLabel('Project', { exact: true });
      if (await projects.isVisible()) await projects.selectOption({ label: projectName });
      else await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: projectName, exact: true }).tap();
      await page.getByRole('button', { name: 'Details', exact: true }).tap();
      await page.getByLabel('Task title', { exact: true }).fill(taskTitle);
      await page.getByLabel('Notes (optional)', { exact: true }).fill('Review the note before sending the final material to the customer.');
      await page.getByRole('dialog', { name: 'New task' }).getByRole('button', { name: 'Add task', exact: true }).tap();
      const control = page.getByRole('button', { name: `Complete ${taskTitle}`, exact: true });
      await control.tap();
      return page.locator('.task-row').filter({ has: page.getByRole('button', { name: `${taskTitle}, completed`, exact: true }) });
    }
    const matchedRow = await addAndComplete(projectName, 'Finish the customer brief');
    const linked = matchedRow.getByRole('button', { name: `Open task: ${title}`, exact: true });
    await expect(linked).toBeVisible();
    await capture(matchedRow, 'completed-created');
    await linked.tap();
    const detail = page.getByRole('dialog', { name: 'Task details' });
    const due = detail.getByLabel('Due time (optional)', { exact: true });
    await expect(detail.getByLabel('Task title', { exact: true })).toHaveValue(title);
    await expect(due).toHaveValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    await expect(due).toHaveAccessibleDescription(/Saved time: .* \d{1,2}:\d\d [AP]M GMT-/);
    expect(await due.evaluate(input => input.getBoundingClientRect().right <= input.closest('aside').getBoundingClientRect().right)).toBe(true);
    await capture(due, 'created-task-due-time');
    await detail.getByRole('button', { name: 'Close task details', exact: true }).tap();

    const unrelated = 'File the unrelated receipt';
    const readback = async () => {
      const id = fixture.db.prepare('SELECT id FROM tasks WHERE title=?').get(unrelated).id;
      const response = await page.request.get(`${fixture.origin}/api/tasks/${id}/reaction`, { headers });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const nonmatchRow = await addAndComplete(otherProjectName, unrelated);
    await expect.poll(async () => (await readback())?.state).toBe('FINISHED');
    expect(await readback()).toMatchObject({ receipt: null, outcome: { classification: 'COMPLETED', result: { status: 'NO_OP' }, effects: [] } });
    await expect(nonmatchRow.getByRole('region', { name: 'Customization outcome' })).toHaveCount(0);
    const centerGap = await nonmatchRow.evaluate(row => {
      const circle = row.querySelector('.completion').getBoundingClientRect();
      const title = row.querySelector('.task-open > span');
      return Math.abs(circle.top + circle.height / 2 - title.getBoundingClientRect().top - parseFloat(getComputedStyle(title).lineHeight) / 2);
    });
    expect(centerGap).toBeLessThan(3);
    await capture(nonmatchRow, 'completed-nonmatch');
    await nonmatchRow.locator('.task-open').tap();
    await expect(detail.getByRole('region', { name: 'Customization outcome' })).toContainText('This customization made no change.');
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title=?").get(title).n).toBe(1);
  } finally { await fixture.close(); }
});
