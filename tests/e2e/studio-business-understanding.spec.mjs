import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';

test('offline due-date conversation explains checked behavior and keeps approval, use and later edits separate', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await startAuthoringFixture({ missingDue: true, intentResolutions: ['prepare', 'prepare', 'prepare'] });
  const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const composer = studio.getByLabel('Message to Daymark assistant', { exact: true });
  const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
  const send = async text => {
    await composer.fill(text);
    await studio.getByRole('button', { name: 'Send', exact: true }).click();
  };
  const seeChange = async () => {
    await studio.locator('#studio-view-saved').click();
    await expect(studio.getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
    await expect(decision.locator('.rs-review-status')).not.toHaveText('Checking saved results…');
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const nativeBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    await send('Could you help me give new tasks a due date automatically?');
    await expect(studio.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    expect(fixture.requests.map(item => item.name)).toEqual(['resolve_intent', 'discover_catalog', 'ask_clarification']);
    await send('Confirmed: every project, only when the new task has no due date. Use exactly 168 hours after addition.');
    await expect(studio.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });

    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    expect(id).toBeTruthy();
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const read = async path => {
      const response = await page.request.get(`${fixture.origin}/api/${path}`, { headers: { 'x-session-context': contextToken } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const state = () => read(`extensions/${id}`);
    const discussion = () => read(`authoring?extensionId=${id}`);
    const checked = await discussion(), initial = await state();
    expect(checked.current.review.eligible).toBe(true);
    const selectedBefore = initial.selection;
    const revisionId = checked.current.review.revisionId;
    const saved = await read(`extensions/${id}/revisions/${revisionId}`);
    expect(saved.source).toBe(fixture.metadata.source);
    const program = JSON.parse(saved.source);
    expect(program.entrypoint).toBe('TaskCreated');
    expect(program.steps).toHaveLength(3);
    expect(program.steps[1].let.cel).toBe('!has(source.dueAt)');
    const proof = await read(`extensions/${id}/evidence/${checked.current.review.evidenceId}`);
    expect(proof.passed).toBe(true);
    expect(proof.summary.cases.map(row => row.outcome)).toEqual(['changed', 'changed', 'unchanged', 'handled-problem']);
    expect(proof.summary.cases.map(row => row.verification)).toEqual(Array(4).fill('matched'));
    expect(proof.reports.slice(0, 2).map(row => row.report.observed.updatedTasks[0].dueAt)).toEqual([
      '2027-01-07T16:00:00.417Z', '2027-01-07T16:00:00.417Z',
    ]);
    expect(proof.summary.cases[3].actual.native.error.code).toBe('ADAPTER_TRANSIENT');
    expect(proof.summary.cases[3].actual.observed.effect).toBe('NONE');
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);

    await composer.fill('Keep this unsent question about weekends.');
    await seeChange();
    await expect(studio.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
    const ruleSummary = studio.locator('.rs-rule-summary');
    await expect(ruleSummary).toContainText('When a new task is added in any project');
    await expect(ruleSummary).toContainText('give it a due date exactly 7 days after it was added');
    await expect(ruleSummary).toContainText('only if it still has no due date when its details are read');
    await expect(studio.locator('.rs-timing')).toContainText('168 elapsed hours');
    await expect(studio.locator('.rs-timing')).toContainText('including weekends');
    await expect(studio.locator('.rs-timing')).toContainText('The local hour may shift when clocks change.');
    await expect(ruleSummary).toContainText('A due date already present when the task is read is kept.');
    await expect(ruleSummary).toContainText('Leave its title, project, notes, status, priority, and tags unchanged.');
    await expect(ruleSummary).toContainText('Turning this on does not update tasks that were added earlier.');
    const comparison = studio.locator('.rs-before-after').first();
    await expect(comparison).toContainText('Added:');
    await expect(comparison).toContainText('Jan 7, 2027');
    await expect(comparison).toContainText('Other task details stayed the same.');
    const cases = decision.locator('.rs-case-disclosure');
    await expect(cases).toHaveCount(4);
    for (const [index, situation, result] of [
      [0, 'New task without a due date', 'Due date added as intended'],
      [1, 'New task in another project', 'Due date added as intended'],
      [2, 'Task already has a due date', 'Existing date kept'],
      [3, 'Task details temporarily unavailable', 'No change when task details were unavailable—as intended'],
    ]) {
      await expect(cases.nth(index).locator('summary')).toContainText(situation);
      await expect(cases.nth(index).locator('summary')).toContainText(result);
      await expect(cases.nth(index).getByText('Matched this example', { exact: true })).toHaveCount(0);
    }
    await expect(cases.nth(3).getByText('Unchecked', { exact: true })).toHaveCount(0);
    const coverage = decision.locator('.rs-coverage');
    await expect(coverage).toContainText('Not covered by this simulation');
    await expect(coverage).toContainText('a missing task');
    await expect(coverage).toContainText('denied access');
    await expect(coverage).toContainText('a rejected change');
    await expect(coverage).toContainText('a change whose result cannot be confirmed');
    await expect(coverage).toContainText('fits your needs around clock changes');
    await expect(coverage).not.toContainText('An unconfirmed change may have happened');
    await expect(decision).not.toContainText('We could not confirm whether the task changed');
    await expect(decision).not.toContainText('Examples we checked');
    const decisionPrompt = decision.getByRole('heading', { name: 'Is this the change you want?', exact: true });
    await expect(decisionPrompt).toHaveText('Is this the change you want?');
    await expect(decisionPrompt.evaluate((node, coverageNode) =>
      !!(coverageNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING), await coverage.elementHandle())).resolves.toBe(true);
    for (const [width, height] of [[1440, 1000], [320, 740], [683, 384]]) {
      await page.setViewportSize({ width, height });
      await expect(composer).toHaveValue('Keep this unsent question about weekends.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await studio.locator('.rs-messages').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const messages = studio.locator('.rs-messages');
      await messages.evaluate(element => { element.scrollTop = 0; });
      await studio.getByRole('heading', { name: 'Summary', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: testInfo.outputPath(`due-date-overview-${width}.png`) });
      await studio.locator('.rs-before-after').first().evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: testInfo.outputPath(`due-date-before-after-${width}.png`) });
      await decision.getByRole('heading', { name: 'Simulation', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: testInfo.outputPath(`simulation-overview-${width}.png`) });
      await cases.nth(3).locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(cases.nth(3)).toHaveJSProperty('open', true);
      await expect(cases.nth(3)).toContainText('What we wanted');
      await expect(cases.nth(3)).toContainText('What happened');
      await expect(cases.nth(3)).toContainText('No change.');
      await cases.nth(3).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await expect(coverage).toBeVisible();
      await expect(decisionPrompt).toBeVisible();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`checked-due-date-${width}.png`) });
      await coverage.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await decision.getByRole('button', { name: 'Approve this change', exact: true }).scrollIntoViewIfNeeded();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`simulation-decision-${width}.png`) });
      await decision.locator('.rs-decision-actions').scrollIntoViewIfNeeded();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`approval-decision-${width}.png`) });
      await page.keyboard.press('Enter');
      await expect(cases.nth(3)).toHaveJSProperty('open', false);
      await decision.getByRole('button', { name: 'Approve this change', exact: true }).scrollIntoViewIfNeeded();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeInViewport();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await decision.getByRole('button', { name: 'Approve this change', exact: true }).click();
    await expect(decision.getByRole('button', { name: 'Turn on for tasks added', exact: true })).toBeEnabled();
    expect((await state()).selection).toEqual(selectedBefore);
    await decision.getByRole('button', { name: 'Turn on for tasks added', exact: true }).click();
    await expect.poll(async () => (await state()).selection.revision?.id).toBe(revisionId);
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    const title = 'A new task without a due date';
    await page.getByLabel('New task title', { exact: true }).fill(title);
    await page.getByRole('button', { name: /^Add task/ }).click();
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    const task = fixture.db.prepare("SELECT id FROM tasks WHERE owner_id='maya' AND title=?").get(title);
    expect(task).toBeTruthy();
    await expect.poll(async () => (await read(`tasks/${task.id}/reaction?trigger=TaskCreated`)).state).toBe('FINISHED');
    const reaction = await read(`tasks/${task.id}/reaction?trigger=TaskCreated`), changed = await read(`tasks/${task.id}`);
    const event = fixture.db.prepare("SELECT input,revision_id FROM task_events WHERE hook_id='TaskCreated' AND source_task_id=?").get(task.id);
    expect(event.revision_id).toBe(revisionId);
    expect(reaction.receipt).toMatchObject({ kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: task.id } });
    expect(Date.parse(changed.dueAt) - Date.parse(JSON.parse(event.input).occurredAt)).toBe(604_800_000);
    expect(changed).toMatchObject({ title, status: 'open', notes: '', tags: [], priority: 'normal' });
    expect(fixture.db.prepare('SELECT * FROM tasks WHERE id<>? ORDER BY id').all(task.id)).toEqual(nativeBefore);

    await page.goto(`${fixture.origin}/#customization=${id}`);
    await page.reload();
    await expect(studio.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await expect(studio.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible();
    const reopened = await discussion();
    expect(reopened.transcript.messages).toEqual(checked.transcript.messages);
    expect(reopened.current.id).toBe(checked.current.id);
    await send(fixture.metadata.editRequest);
    await expect(studio.getByText(fixture.metadata.editedOfferText, { exact: true })).toBeVisible({ timeout: 20_000 });
    const edited = await discussion(), current = await state();
    expect(edited.current.id).toBe(checked.current.id);
    expect(edited.current.review.revisionId).not.toBe(revisionId);
    expect(current.selection.revision.id).toBe(revisionId);
    expect(current.approved).toBe(false);
    const editedProof = await read(`extensions/${id}/evidence/${edited.current.review.evidenceId}`);
    expect(editedProof.reports[0].report.observed.updatedTasks[0].dueAt).toBe('2027-01-05T16:00:00.417Z');
    await composer.fill('Keep this unsent refinement for the next discussion.');
    await seeChange();
    await expect(studio.locator('.rs-rule-facts')).toContainText('120');
    await expect(composer).toHaveValue('Keep this unsent refinement for the next discussion.');
    await studio.locator('#studio-view-active').click();
    await expect(composer).toHaveValue('Keep this unsent refinement for the next discussion.');
    await studio.getByRole('button', { name: 'Return to proposal', exact: true }).click();
    await expect(composer).toHaveValue('Keep this unsent refinement for the next discussion.');
    expect((await state()).selection.revision.id).toBe(revisionId);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('a different supported behavior keeps its exact supplied name and truthful summary after reload', async ({ page }, testInfo) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  const name = 'Review shipping priorities';
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const rule = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId, title: name });
    const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name });
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const api = async (path, body) => {
      const response = await page.request.post(`${fixture.origin}/api/${path}`, {
        headers: { 'x-session-context': contextToken, origin: fixture.origin }, data: body,
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    let saved = await api(`extensions/${extensionId}/compile`, {
      hookId: TASK_HOOK, source: rule.source, label: name, draftVersion: 0,
    });
    saved = await api(`extensions/${extensionId}/scenarios`, {
      revisionId: saved.draft.id, draftVersion: saved.draftVersion, cases: rule.cases,
    });
    saved = await api(`extensions/${extensionId}/simulate`, {
      revisionId: saved.draft.id, draftVersion: saved.draftVersion,
    });
    expect(saved.evidence.passed).toBe(true);
    expect(fixture.requests).toHaveLength(0);
    const exactState = async () => {
      const response = await page.request.get(`${fixture.origin}/api/extensions/${extensionId}`, { headers: { 'x-session-context': contextToken } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };

    await page.goto(`${fixture.origin}/#customization=${extensionId}`);
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
    await expect(studio.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(studio.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
    await expect(studio.locator('.rs-rule-summary')).toContainText(`create a new task titled “${name}”`);
    await expect(studio.locator('.rs-rule-summary')).toContainText(fixture.metadata.projectName);
    await expect(studio.locator('.rs-rule-facts')).toContainText('A task is completed.');
    expect((await exactState()).extension.name).toBe(name);
    await studio.locator('#studio-view-saved').click();
    await expect(studio.getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
    await studio.getByRole('button', { name: 'Hide simulation', exact: true }).click();
    await studio.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(decision.getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('other-behavior-summary-simulation.png') });

    await page.reload();
    const reopened = page.getByRole('region', { name: 'Customization Studio', exact: true });
    await expect(reopened.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(reopened.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
    await expect(reopened.locator('.rs-rule-summary')).toContainText(`create a new task titled “${name}”`);
    const reopenedDecision = reopened.getByRole('article', { name: 'Current decision', exact: true });
    await reopened.locator('#studio-view-saved').click();
    await expect(reopened.getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
    await reopened.getByRole('button', { name: 'Hide simulation', exact: true }).click();
    await reopened.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(reopenedDecision.getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
    expect((await exactState()).extension.name).toBe(name);
    const persisted = fixture.db.prepare('SELECT name FROM extensions WHERE id=?').get(extensionId);
    expect(persisted.name).toBe(name);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('Draft and Review reach the same unobscured inline review at desktop, narrow and short sizes', async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startAuthoringFixture({ missingDue: true });
  const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const composer = studio.getByLabel('Message to Daymark assistant', { exact: true });
  const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
  let release;
  const expectDestination = async name => {
    const heading = studio.getByRole('heading', { name, exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect.poll(() => heading.evaluate(node => {
      const region = node.closest('.read-studio');
      const log = region.querySelector('.rs-messages');
      const scroller = getComputedStyle(region).overflowY === 'auto' ? region : log;
      const bounds = scroller.getBoundingClientRect(), rect = node.getBoundingClientRect();
      const stickyBottom = Math.max(0, ...[...region.querySelectorAll(':scope > .rs-header, :scope > .rs-status-summary')]
        .filter(element => getComputedStyle(element).position === 'sticky')
        .map(element => element.getBoundingClientRect().bottom));
      return rect.top >= Math.max(0, bounds.top, stickyBottom) - 1
        && rect.bottom <= Math.min(innerHeight, bounds.bottom) + 1;
    })).toBe(true);
  };
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await composer.fill('Could you help me give new tasks a due date automatically?');
    await studio.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(studio.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await composer.fill('Confirmed: every project, only when the new task has no due date. Use exactly 168 hours after addition.');
    await studio.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(studio.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    const { contextToken } = await (await page.request.get(fixture.origin + '/api/session')).json();
    const state = async () => {
      const response = await page.request.get(`${fixture.origin}/api/extensions/${id}`, { headers: { 'x-session-context': contextToken } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const before = await state(), providerCalls = fixture.requests.map(request => request.name);
    const tasksBefore = fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const writes = [];
    page.on('request', request => {
      if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url());
    });
    const draft = 'Keep this unsent navigation question exactly.';
    await composer.fill(draft);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 740 }, { width: 683, height: 384 }]) {
      await page.setViewportSize(viewport);
      for (const invoker of ['header', 'review']) {
        const gate = Promise.withResolvers(), proofArrived = Promise.withResolvers(), sourceArrived = Promise.withResolvers();
        release = gate.resolve;
        const proofPath = `**/api/extensions/${id}/evidence/${before.evidence.id}`;
        const sourcePath = `**/api/extensions/${id}/revisions/${before.draft.id}`;
        await page.route(sourcePath, async route => {
          const response = await route.fetch();
          sourceArrived.resolve(); await gate.promise;
          try { await route.fulfill({ response }); } catch { /* Teardown can close a held page. */ }
        });
        await page.route(proofPath, async route => {
          const response = await route.fetch();
          proofArrived.resolve(); await gate.promise;
          try { await route.fulfill({ response }); } catch { /* Teardown can close a held page. */ }
        });
        await page.reload();
        await expect(composer).toHaveValue(draft);
        const link = invoker === 'header' ? studio.locator('#studio-view-saved')
          : studio.getByRole('button', { name: 'Review', exact: true });
        await expect(link).toHaveAccessibleName(invoker === 'header' ? /Draft:/ : 'Review');
        await link.click();
        await Promise.all([proofArrived.promise, sourceArrived.promise]);
        gate.resolve();
        await expect(studio.locator('.rs-rule-summary')).toContainText('give it a due date exactly 7 days after it was added');
        await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expectDestination(invoker === 'header' ? 'Summary' : 'Simulation');
        await expect(composer).toHaveValue(draft);
        await decision.getByRole('button', { name: 'Go to approval', exact: true }).click();
        await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(decision.locator('#studio-decision-step')).toBeFocused();
        await decision.getByRole('button', { name: 'Approve this change', exact: true }).scrollIntoViewIfNeeded();
        await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(composer).toHaveValue(draft);
        await page.unroute(proofPath); await page.unroute(sourcePath);
      }
    }
    // Reading the transcript must cancel the late anchor without changing focus.
    await page.setViewportSize({ width: 683, height: 384 });
    const gate = Promise.withResolvers(), proofArrived = Promise.withResolvers();
    release = gate.resolve;
    const proofPath = `**/api/extensions/${id}/evidence/${before.evidence.id}`;
    await page.route(proofPath, async route => {
      const response = await route.fetch();
      proofArrived.resolve(); await gate.promise;
      try { await route.fulfill({ response }); } catch { /* Teardown can close a held page. */ }
    });
    await page.reload();
    await expect(studio.locator('.rs-rule-summary')).toContainText('give it a due date exactly 7 days after it was added');
    await studio.locator('#studio-view-saved').click();
    await proofArrived.promise;
    await expectDestination('Summary');
    const scroller = studio.locator('.rs-messages');
    await expect(scroller).toHaveCSS('overflow-y', 'auto');
    const status = studio.locator(':scope > .rs-status-summary');
    await expect(status).toBeInViewport({ ratio: 1 });
    const bounds = await status.boundingBox();
    expect(bounds).not.toBeNull();
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.rs-status-summary'), point)).toBe(true);
    const previousScroll = await scroller.evaluate(element => element.scrollTop);
    await scroller.hover({ position: { x: 5, y: 5 } });
    await page.mouse.wheel(0, 120);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(previousScroll + 20);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const readingPosition = await scroller.evaluate(element => element.scrollTop);
    const summary = studio.getByRole('heading', { name: 'Summary', exact: true });
    const readingTop = await summary.evaluate(element => element.getBoundingClientRect().top);
    await expect(summary).toBeFocused();
    gate.resolve();
    await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(async () => Math.abs(await scroller.evaluate(element => element.scrollTop) - readingPosition)).toBeLessThanOrEqual(2);
    await expect.poll(async () => Math.abs(await summary.evaluate(element => element.getBoundingClientRect().top) - readingTop)).toBeLessThanOrEqual(2);
    await expect(summary).toBeFocused();
    await expect(composer).toHaveValue(draft);
    await page.unroute(proofPath);
    // Pointer reading on the transcript scroller must also cancel a pending anchor,
    // even when focus remains on Summary (as with a scrollbar/touch gesture).
    const pointerGate = Promise.withResolvers(), pointerProof = Promise.withResolvers();
    release = pointerGate.resolve;
    await page.route(proofPath, async route => {
      const response = await route.fetch();
      pointerProof.resolve(); await pointerGate.promise;
      try { await route.fulfill({ response }); } catch { /* Teardown can close a held page. */ }
    });
    await page.reload();
    await expect(studio.locator('.rs-rule-summary')).toContainText('give it a due date exactly 7 days after it was added');
    await studio.locator('#studio-view-saved').click();
    await pointerProof.promise;
    await expectDestination('Summary');
    // Dispatch on the real transcript scroller; changing scrollTop emulates the
    // browser's scrollbar movement without assuming OS scrollbar coordinates.
    await scroller.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await scroller.evaluate(element => { element.scrollTop += 120; });
    const pointerPosition = await scroller.evaluate(element => element.scrollTop);
    const pointerTop = await summary.evaluate(element => element.getBoundingClientRect().top);
    await expect(summary).toBeFocused();
    pointerGate.resolve();
    await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(async () => Math.abs(await scroller.evaluate(element => element.scrollTop) - pointerPosition)).toBeLessThanOrEqual(2);
    await expect.poll(async () => Math.abs(await summary.evaluate(element => element.getBoundingClientRect().top) - pointerTop)).toBeLessThanOrEqual(2);
    await expect(summary).toBeFocused();
    await page.unroute(proofPath);
    expect(await state()).toEqual(before);
    expect(fixture.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasksBefore);
    expect(fixture.requests.map(request => request.name)).toEqual(providerCalls);
    expect(writes).toEqual([]);
  } finally { release?.(); await page.close(); await fixture.close(); }
});
