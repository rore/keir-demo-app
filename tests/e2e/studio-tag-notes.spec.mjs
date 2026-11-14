import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

test('natural-language tag/notes rule reaches real compilation, saved review and every native create entry', async ({ page }) => {
  test.setTimeout(90_000);
  const f = await startAuthoringFixture({ tagNotes: true });
  const ui = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
  const navigate = name => button(name, page.getByRole('navigation', { name: 'Main navigation', exact: true })).click();
  const send = async text => { await ui.getByLabel('Message to Daymark assistant', { exact: true }).fill(text); await button('Prepare changes', ui).click(); };
  const counts = () => ['tasks', 'task_events', 'task_create_operations', 'task_effect_receipts']
    .map(table => f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  const selections = () => f.db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.origin); await page.getByRole('button', { name: /^Continue as Maya/ }).click();
    await navigate('Customizations'); await button('New customization').click();
    const before = counts(), originalSelections = selections();
    await send('Before saving a new task with more than three tags, require notes.');
    await expect(ui.getByText(f.metadata.question, { exact: true })).toBeVisible();
    await send('Confirmed: count normalized distinct tags. Four through eight tags are allowed with notes. Whitespace-only notes do not count. Do not change existing tasks or later edits.');
    await expect(ui.getByText(f.metadata.offerText, { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(counts()).toEqual(before); expect(selections()).toEqual(originalSelections);
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    const session = await (await page.request.get(f.origin + '/api/session')).json();
    const read = async path => { const response = await page.request.get(f.origin + '/api/' + path,
      { headers: { 'x-session-context': session.contextToken } }); expect(response.ok(), await response.text()).toBe(true); return response.json(); };
    const state = () => read('extensions/' + id);
    const current = (await read('authoring?extensionId=' + id)).current;
    const proof = await read(`extensions/${id}/evidence/${current.review.evidenceId}`);
    const saved = await read(`extensions/${id}/revisions/${current.review.revisionId}`);
    expect(JSON.parse(saved.artifact).format).toBe('keir-artifact/4');
    expect(saved.pins.modelRef.format).toBe('keir-dcm/4');
    expect(saved.ruleDescription.coverage).toBe('complete');
    expect(proof.passed).toBe(true); expect(proof.reports).toHaveLength(8);
    expect(proof.reports.every(row => row.report.calls.length === 0 && row.report.native.effects.length === 0)).toBe(true);
    await button('See proposed change', ui).first().click();
    await expect(ui.locator('.rs-rule-facts')).toContainText('more than 3 distinct normalized tags');
    await expect(ui.locator('.rs-rule-facts')).toContainText('no notes');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 740 }, { width: 683, height: 384 }]) {
      await page.setViewportSize(viewport);
      await expect(ui.locator('.rs-inline-behavior')).toContainText('Whitespace-only notes count as no notes');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await button('View simulation', ui).click();
    const review = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(review).toContainText('Example tasks; your tasks are unchanged.');
    await expect(review).toContainText('This example deliberately');
    await expect(review).toContainText('The rule did not run.');
    await expect(ui.locator('.rs-rule-facts')).toContainText('more than 3 distinct normalized tags');
    await expect(review.getByText('Saving stopped as expected', { exact: true })).toBeVisible();
    await button('Approve this change', review).click();
    expect(selections()).toEqual(originalSelections); expect(counts()).toEqual(before);
    await button('Turn on for new tasks', review).click();
    expect(counts()).toEqual(before);
    await expect.poll(async () => (await state()).selection.revision?.id).toBe(current.review.revisionId);
    expect(selections().filter(row => row.owner_id !== 'maya' || row.hook_id !== 'TaskBeforeCreate'))
      .toEqual(originalSelections.filter(row => row.owner_id !== 'maya' || row.hook_id !== 'TaskBeforeCreate'));
    await navigate('Customizations');
    await expect(page.getByRole('article', { name: 'Untitled customization', exact: true })).toContainText('more than 3 distinct normalized tags');
    await button('Open', page.getByRole('article', { name: 'Untitled customization', exact: true })).click();
    await button('View what’s in use', ui).click();
    await expect(ui).toContainText('more than 3 distinct normalized tags');
    await navigate('Tasks');
    await button(f.metadata.projectName, page.getByRole('navigation', { name: 'Projects', exact: true })).click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    const post = () => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
    const providerCalls = f.requests.length;
    for (const entry of ['details', 'quick-button', 'quick-enter']) {
      await button('Details').click();
      await dialog.getByLabel('Task title', { exact: true }).fill('Tagged ' + entry);
      await dialog.getByLabel('Tags', { exact: true }).fill('client, review, internal, launch');
      await dialog.getByLabel('Notes (optional)', { exact: true }).fill(' \t ');
      if (entry !== 'details') await button('Cancel', dialog).click();
      const deniedResponse = post(), deniedBefore = counts();
      if (entry === 'details') await button('Add task', dialog).click();
      else if (entry === 'quick-button') await button('Add task', page.locator('.quick-add')).click();
      else await page.getByLabel('New task title', { exact: true }).press('Enter');
      const denied = await deniedResponse;
      expect(denied.status(), await denied.text()).toBe(422);
      expect(await denied.json()).toMatchObject({ state: 'NOT_CREATED', code: 'RULE_DENIED', message: f.metadata.message });
      const alert = dialog.getByRole('alert');
      await expect(alert).toBeFocused(); await expect(alert).toContainText(f.metadata.message);
      await expect(dialog.getByLabel('Tags', { exact: true })).toHaveValue('client, review, internal, launch');
      await expect(dialog.getByLabel('Notes (optional)', { exact: true })).toHaveValue(' \t ');
      expect(counts()).toEqual([deniedBefore[0], deniedBefore[1], deniedBefore[2] + 1, deniedBefore[3]]);
      if (entry === 'details') await dialog.getByLabel('Notes (optional)', { exact: true }).fill('Required context');
      else { await dialog.getByLabel('Tags', { exact: true }).fill(' Client , client, REVIEW, internal'); await dialog.getByLabel('Notes (optional)', { exact: true }).fill(''); }
      const correctedResponse = post(); await button('Add task', dialog).click(); const corrected = await correctedResponse;
      expect(corrected.status(), await corrected.text()).toBe(201);
      expect(corrected.request().headers()['x-task-create-id']).not.toBe(denied.request().headers()['x-task-create-id']);
      const task = await corrected.json();
      expect(task.tags).toEqual(entry === 'details' ? ['client', 'review', 'internal', 'launch'] : ['client', 'review', 'internal']);
      expect(await read('tasks/' + task.id)).toEqual(task);
      expect(counts()).toEqual([deniedBefore[0] + 1, deniedBefore[1] + 1, deniedBefore[2] + 2, deniedBefore[3]]);
      await expect(dialog).not.toBeVisible();
    }
    expect(f.requests.length).toBe(providerCalls);
    await page.reload(); await navigate('Customizations');
    await expect(page.getByRole('article', { name: 'Untitled customization', exact: true })).toContainText('more than 3 distinct normalized tags');
    expect((await state()).selection.revision.id).toBe(current.review.revisionId);
    expect((await read(`extensions/${id}/revisions/${current.review.revisionId}`)).pins.artifactDigest).toBe(saved.pins.artifactDigest);
    expect(f.requests.length).toBe(providerCalls); expect(errors).toEqual([]);
  } finally { await f.close(); }
});
