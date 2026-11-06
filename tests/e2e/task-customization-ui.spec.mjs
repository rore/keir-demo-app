import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../../src/server.mjs';

// Public projection checks only: these fixtures do not qualify a runtime or create tasks through an extension.
const test = base.extend({
  demo: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'daymark-task-ui-'));
    const reservation = createServer();
    await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const app = await start({ directory, port, staticRoot: resolve(process.env.TASK_UI_STATIC_ROOT ?? 'dist') });
    try { await use(app); } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function enter(page, demo) {
  await page.goto(demo.origin); await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByRole('heading', { name: 'The spring collection', exact: true })).toBeVisible();
}
async function nativeData(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const headers = { 'X-Session-Context': session.contextToken, 'Content-Type': 'application/json' };
    const projects = await (await fetch('/api/projects', { headers })).json(), project = projects[0];
    const tasks = await (await fetch('/api/projects/' + project.id + '/tasks', { headers })).json();
    const created = await (await fetch('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, title: 'Review the finished task' }) })).json();
    return { project, source: tasks.find(task => task.status === 'open'), created };
  });
}
async function publicStudio(page, { mismatch = false, unavailable = false, unavailableRead = false, unknownEffect = false, noActive = false } = {}) {
  const task = { id: 'example-task', title: 'Finish packaging sketches', status: 'COMPLETED', projectId: 'example-project', projectName: 'Launch' };
  const effect = title => ({ projectId: task.projectId, projectName: task.projectName, title });
  const report = (id, revisionId, title, failed = false) => ({ id, revisionId, kind: 'authored', identity: {}, passed: !failed, reports: [{
    id: 'completed-in-launch', label: 'A label does not prove a task was created', expected: { classification: unknownEffect ? 'UNCERTAIN' : unavailableRead ? 'BUSINESS_REJECTION' : 'COMPLETED', createdTasks: unknownEffect ? null : unavailableRead ? [] : [effect(title)], updatedTasks: unknownEffect ? null : [] },
    report: { status: failed ? 'MISMATCH' : 'PASS', scenario: { task: unavailableRead ? { id: task.id, title: 'Example task' } : task },
      ...(unavailableRead ? { calls: [{ capability: 'tasks.get' }], native: { error: { code: 'TASK_NOT_FOUND' } } } : {}),
      observed: { effect: unknownEffect ? 'UNKNOWN' : failed || unavailableRead ? 'NONE' : 'CONFIRMED',
        createdTasks: unknownEffect ? null : failed || unavailableRead ? [] : [effect(title)], updatedTasks: unknownEffect ? null : [] },
      mismatches: failed ? [{ code: 'EXPECTED_TASK_MISSING' }] : [] },
  }] });
  const a = { id: 'active-revision', templateId: 'authored', kind: 'authored', suiteDigest: 'suite-a', label: 'Untrusted active label', pins: { modelRef: { format: 'keir-dcm/2' } }, provenance: 'customer', extensionId: 'task-customization', extensionName: 'My follow-up' };
  const b = { ...a, id: 'draft-revision', suiteDigest: 'suite-b', label: 'Source says CREATED but this is not effect evidence' };
  let state = { owner: { id: 'maya', name: 'Maya' }, extension: { id: 'task-customization', name: 'My follow-up', hookId: 'TaskCompleted' }, retired: false,
    executionAvailability: unavailable ? { available: false, message: 'Task customizations cannot run in this installation yet. Your tasks still work.' } : undefined, catalog: [], draftVersion: 2, draft: b, evidence: { id: 'proof-b', revisionId: b.id, passed: !mismatch }, approved: false, approvedEvidenceId: null,
    selection: { generation: 7, revision: noActive ? null : a, eligible: !noActive && !unavailable, approvedEvidenceId: noActive ? null : 'proof-a' }, history: [], restoreTargets: [], evidenceHistory: [{ id: 'proof-b', revisionId: b.id }], historyNext: null };
  const proofs = { 'proof-a': report('proof-a', a.id, 'Review completion'), 'proof-b': report('proof-b', b.id, 'Prepare next step', mismatch) }, mutations = [];
  const conversation = { id: 'task-discussion', extensionId: state.extension.id, retired: false, purpose: 'REVISE', version: 1, status: 'REVIEW_AVAILABLE', runId: 'run-one',
    operation: { id: 'operation-one', runId: 'run-one', version: 1 }, draft: { revisionId: b.id, draftVersion: 2, suiteDigest: b.suiteDigest },
    selection: { revisionId: noActive ? null : a.id, generation: 7 }, code: null, review: { revisionId: b.id, draftVersion: 2, suiteDigest: b.suiteDigest, evidenceId: 'proof-b', eligible: !mismatch },
    messages: [{ id: 'checked', role: 'assistant', kind: 'review', text: 'The saved examples compare the current follow-up with your proposed next step.', receipt: { revisionId: b.id, draftVersion: 2, suiteDigest: b.suiteDigest, evidenceId: 'proof-b' } }] };
  await page.route('**/api/extensions**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    let body;
    if (path === '/api/extensions') body = { items: [state], owner: state.owner, selection: state.selection, catalog: [], executionAvailability: state.executionAvailability, next: null };
    else if (path.endsWith('/catalog')) return route.continue();
    else if (path.endsWith('/evidence/proof-a')) body = proofs['proof-a'];
    else if (path.endsWith('/evidence/proof-b')) body = proofs['proof-b'];
    else if (path.endsWith('/revisions/' + b.id)) body = { revisionId: b.id, source: '{"entrypoint":"TaskCompleted"}', artifact: '{"format":"keir-artifact/2"}', pins: b.pins, cases: ['independent example'], suiteDigest: b.suiteDigest };
    else if (path.endsWith('/approve')) { mutations.push({ path, body: route.request().postDataJSON() }); state = { ...state, approved: true, approvedEvidenceId: 'proof-b' }; body = state; }
    else if (path.endsWith('/activate')) { mutations.push({ path, body: route.request().postDataJSON() }); state = { ...state, selection: { generation: 8, revision: b, eligible: true, approvedEvidenceId: 'proof-b' } }; body = state; }
    else if (path === '/api/extensions/task-customization') body = state;
    else return route.fulfill({ status: 404, json: { message: 'Unavailable projection' } });
    await route.fulfill({ json: body });
  });
  await page.route('**/api/authoring**', route => route.fulfill({ json: { availability: { available: false, code: 'AI_NOT_CONFIGURED', provider: null, model: null }, conversations: [{ id: conversation.id, extensionId: state.extension.id, purpose: 'REVISE', version: 1, status: conversation.status, runId: conversation.runId, operationId: conversation.operation.id }], current: conversation, next: null } }));
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
  await page.locator('#edit-task-customization').click();
  return { mutations };
}

test('inline review and secondary comparison retain their exact task proofs and separate decisions', async ({ page, demo }) => {
  await enter(page, demo); const { mutations } = await publicStudio(page);
  await studio(page).locator('#studio-view-saved').click();
  const decision = studio(page).getByRole('article', { name: 'Current decision', exact: true });
  const proposed = studio(page).getByRole('region', { name: 'Checked proposed behavior', exact: true });
  await expect(proposed).toContainText('Prepare next step'); await expect(proposed).toContainText('Launch');
  await decision.getByRole('button', { name: 'Inspect examples and what’s in use', exact: true }).click();
  const comparison = studio(page).getByRole('article', { name: 'Sample results', exact: true });
  const current = comparison.getByRole('region', { name: 'Checked behavior currently in use', exact: true });
  await expect(current).toContainText('Review completion');
  await expect(current).toContainText('Finish packaging sketches');
  await expect(comparison.getByRole('region', { name: 'Saved proposed example', exact: true })).toContainText('Prepare next step');
  await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
  expect(mutations).toEqual([]); await studio(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  const use = studio(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true });
  await expect(use).toBeEnabled();
  expect(mutations).toEqual([{ path: '/api/extensions/task-customization/approve', body: { revisionId: 'draft-revision', draftVersion: 2, evidenceId: 'proof-b' } }]);
  await use.click();
  await expect(decision.locator('.rs-review-status')).toHaveText('On for my tasks');
  expect(mutations[1]).toEqual({ path: '/api/extensions/task-customization/activate',
    body: { revisionId: 'draft-revision', draftVersion: 2, generation: 7, evidenceId: 'proof-b' } });
});

test('an unavailable installation keeps review and approval usable but disables turning on', async ({ page, demo }) => {
  await enter(page, demo); const { mutations } = await publicStudio(page, { unavailable: true });
  await expect(studio(page)).toContainText('Task customizations cannot run in this installation yet. Your tasks still work.');
  await studio(page).locator('#studio-view-saved').click();
  await studio(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  await expect(studio(page).getByRole('button', { name: 'Turn on for tasks completed', exact: true })).toBeDisabled();
  await expect(studio(page).getByRole('log', { name: 'Studio conversation' })).toContainText('This change is approved and saved. Task customizations cannot run in this installation yet.');
  await expect(studio(page)).not.toContainText('ready to turn on');
  await expect(studio(page).locator('.rs-review-status')).toHaveText('Approved · Still off');
  expect(mutations.map(item => item.path)).toEqual(['/api/extensions/task-customization/approve']);
});

test('without a current version the proposed proof uses the conversation width', async ({ page, demo }, testInfo) => {
  await enter(page, demo); await publicStudio(page, { noActive: true, unavailable: true });
  await studio(page).locator('#studio-view-saved').click();
  const proposed = studio(page).getByRole('region', { name: 'Checked proposed behavior', exact: true });
  await expect(proposed).toContainText('Prepare next step');
  await expect(studio(page).getByRole('region', { name: 'Checked behavior currently in use', exact: true })).toHaveCount(0);
  const width = await proposed.evaluate(node => {
    const parentStyle = getComputedStyle(node.parentElement);
    return { proof: node.getBoundingClientRect().width,
      available: node.parentElement.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight) };
  });
  expect(width.proof).toBeGreaterThanOrEqual(width.available * 0.98);
  await page.screenshot({ path: testInfo.outputPath('sole-proposed-proof.png'), fullPage: true });
  await studio(page).getByRole('button', { name: 'Approve this change', exact: true }).click();
  await studio(page).getByRole('button', { name: 'Hide simulation', exact: true }).click();
  await expect(studio(page).getByRole('log', { name: 'Studio conversation' })).toContainText('This change is approved and saved.');
  await expect(studio(page)).not.toContainText('ready to turn on');
  await page.screenshot({ path: testInfo.outputPath('approved-unavailable-chat.png'), fullPage: true });
});

test('mismatching task creation remains an inspectable example without an approval action', async ({ page, demo }) => {
  await enter(page, demo); const { mutations } = await publicStudio(page, { mismatch: true });
  await studio(page).getByText('The saved examples compare the current follow-up with your proposed next step.', { exact: true }).locator('..').getByRole('button', { name: 'View checked examples', exact: true }).click();
  const results = studio(page).getByRole('article', { name: 'Current decision', exact: true });
  await expect(results).toContainText('Create “Prepare next step”'); await expect(results).toContainText('No change.');
  await expect(results).toContainText('Needs correction'); await expect(studio(page).getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('a checked unavailable-source case can prove no effect without inventing task details', async ({ page, demo }) => {
  await enter(page, demo); await publicStudio(page, { unavailableRead: true });
  await studio(page).locator('#studio-view-saved').click();
  const proposed = studio(page).getByRole('region', { name: 'Checked proposed behavior', exact: true });
  await expect(proposed).toContainText('The task could not be found.');
  await expect(proposed).not.toContainText('Finish packaging sketches');
  await expect(proposed).toContainText('No change.');
  await expect(studio(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
});

test('an independently expected UNKNOWN stays reviewable without claiming a task or no effect', async ({ page, demo }) => {
  await enter(page, demo); await publicStudio(page, { unknownEffect: true });
  await studio(page).locator('#studio-view-saved').click();
  const proposed = studio(page).getByRole('region', { name: 'Checked proposed behavior', exact: true });
  await expect(proposed).toContainText('An uncertain write outcome.');
  await expect(proposed).toContainText('Change not confirmed.');
  await expect(proposed).toContainText('Matches expected uncertainty · Change not confirmed');
  await expect(proposed.locator('.rs-created-example')).toHaveCount(0);
  await expect(proposed).not.toContainText('No change.');
  await expect(studio(page).getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
});

test('a source-authored CREATED label does not become a native task link', async ({ page, demo }) => {
  await enter(page, demo); const { source } = await nativeData(page);
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'FINISHED', outcome: { classification: 'COMPLETED', result: { status: 'CREATED' }, effects: [] }, receipt: null } }));
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Customization outcome', exact: true });
  await expect(result).toContainText('No task was added by this customization.');
  await expect(result.getByRole('button', { name: /Open task:/ })).toHaveCount(0);
});

test('a failed first task creation result read keeps a read-only retry available', async ({ page, demo }) => {
  await enter(page, demo);
  const { created } = await nativeData(page);
  await page.reload();
  const writes = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  let reads = 0;
  const retry = Promise.withResolvers();
  await page.route(url => url.pathname === '/api/tasks/' + created.id + '/reaction' && url.searchParams.get('trigger') === 'TaskCreated', async route => {
    reads++;
    if (reads === 1) return route.fulfill({ status: 503, json: { message: 'Result temporarily unavailable.' } });
    await retry.promise;
    return route.fulfill({ json: { state: 'FINISHED', workflow: true, receipt: null,
      outcome: { classification: 'COMPLETED', result: { status: 'NO_OP' }, effects: [] } } });
  });
  await page.getByRole('button', { name: created.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Task creation customization outcome', exact: true });
  await expect(result.getByRole('alert')).toContainText('The customization result could not be checked.');
  const check = result.getByRole('button', { name: 'Check result', exact: true });
  try {
    await check.click();
    await expect(check).toBeDisabled();
    await expect(check).toBeFocused();
  } finally { retry.resolve(); }
  await expect(result.getByRole('status')).toHaveText('This customization made no change.');
  await expect(result.getByRole('alert')).toHaveCount(0);
  expect(reads).toBe(2);
  expect(writes).toEqual([]);
});

test('reconciliation can reveal an owned task without replacing the original UNKNOWN result', async ({ page, demo }) => {
  await enter(page, demo); const { source, created } = await nativeData(page);
  const original = { classification: 'UNCERTAIN', effects: [{ state: 'UNKNOWN' }] };
  let completions = 0, reconciliations = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/' + source.id + '/complete') completions++; });
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'FINISHED', outcome: original, receipt: null } }));
  await page.route('**/api/tasks/' + source.id + '/reaction/reconcile', route => { reconciliations++; return route.fulfill({ json: { state: 'FINISHED', outcome: original,
    reconciliation: { observedAt: new Date().toISOString(), receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: created.id } } } } }); });
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Customization outcome', exact: true });
  await expect(result).toContainText('Could not confirm whether a task was added.'); await expect(result.getByRole('button', { name: /Open task:/ })).toHaveCount(0);
  await result.getByRole('button', { name: 'Reconcile saved observation', exact: true }).click();
  await expect(result.getByRole('status')).toHaveText('Created “' + created.title + '”');
  await result.getByText('Result details', { exact: true }).click();
  await expect(result).toContainText('The original runtime outcome remains uncertain.');
  await expect(result.getByLabel('Original runtime outcome', { exact: true })).toContainText('UNCERTAIN');
  await expect(result.getByRole('button', { name: 'Open task: ' + created.title, exact: true })).toBeVisible();
  expect(completions).toBe(1); expect(reconciliations).toBe(1);
  await result.getByRole('button', { name: 'Open task: ' + created.title, exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(created.title);
  await page.keyboard.press('Escape');
  await expect(result.getByRole('button', { name: 'Open task: ' + created.title, exact: true })).toBeFocused();
});

test('a confirmed receipt never exposes a task that the current owner cannot read', async ({ page, demo }) => {
  await enter(page, demo); const { source } = await nativeData(page);
  const foreign = demo.db.prepare("SELECT id,title FROM tasks WHERE owner_id='leo' LIMIT 1").get();
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'FINISHED', outcome: { classification: 'COMPLETED', effects: [] },
    receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: foreign.id } } } }));
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Customization outcome', exact: true });
  await expect(result).toContainText('A task was added, but it is unavailable here.');
  await expect(result.getByRole('button', { name: /Open task:/ })).toHaveCount(0);
  await expect(page.getByText(foreign.title, { exact: true })).toHaveCount(0);
});

test('a late owned-task lookup cannot repopulate the next person’s workspace', async ({ page, demo }) => {
  await enter(page, demo); const { source, created } = await nativeData(page);
  let arrived, release;
  const started = new Promise(done => { arrived = done; });
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'FINISHED', outcome: { classification: 'COMPLETED', effects: [] },
    receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: created.id } } } }));
  await page.route('**/api/tasks/' + created.id, async route => {
    const response = await route.fetch(); arrived(); await new Promise(done => { release = done; });
    try { await route.fulfill({ response }); } catch { /* The old owner request is aborted on the switch. */ }
  });
  try {
    await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click(); await started;
    await page.getByRole('combobox', { name: 'Demo person', exact: true }).selectOption('sam');
    await expect(page.getByRole('combobox', { name: 'Demo person', exact: true })).toHaveValue('sam');
    release();
    await expect(page.getByRole('button', { name: /Open task:/ })).toHaveCount(0);
    await expect(page.getByText(created.title, { exact: true })).toHaveCount(0);
    await expect(page.getByText(source.title, { exact: true })).toHaveCount(0);
  } finally { release?.(); }
});

test('a lost completion response is read back without completing or writing again', async ({ page, demo }) => {
  await enter(page, demo); const { source } = await nativeData(page); let completions = 0;
  await page.route('**/api/tasks/' + source.id + '/complete', async route => { completions++; await route.fetch(); await route.abort('failed'); });
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'NO_BINDING', outcome: null, receipt: null } }));
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  await expect(page.getByRole('button', { name: source.title + ', completed', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Customization outcome', exact: true })).toContainText('No customization was recorded');
  expect(completions).toBe(1); expect(demo.db.prepare('SELECT status FROM tasks WHERE id=?').get(source.id).status).toBe('completed');
});

test('a confirmed task arrival refreshes the project without replacing unsaved native fields', async ({ page, demo }) => {
  await enter(page, demo); const { source, created } = await nativeData(page); let arrived, release;
  const started = new Promise(done => { arrived = done; });
  const other = demo.db.prepare("SELECT title FROM tasks WHERE owner_id='maya' AND id!=? AND id!=? AND project_id=? LIMIT 1").get(source.id, created.id, source.projectId);
  await page.route('**/api/tasks/' + source.id + '/reaction', async route => {
    arrived(); await new Promise(done => { release = done; });
    await route.fulfill({ json: { state: 'FINISHED', outcome: { classification: 'COMPLETED', effects: [] }, receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: created.id } } } });
  });
  try {
    await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click(); await started;
    await page.getByRole('button', { name: other.title, exact: true }).click();
    await page.getByLabel('Task title', { exact: true }).fill('Keep my unsaved native title');
    await page.getByLabel('Notes (optional)').fill('Keep these unsaved native notes');
    release();
    await expect(page.getByRole('button', { name: 'Open task: ' + created.title, exact: true })).toBeAttached();
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Keep my unsaved native title');
    await expect(page.getByLabel('Notes (optional)')).toHaveValue('Keep these unsaved native notes');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
  } finally { release?.(); }
});

for (const [label, projection, expected] of [
  ['native NONE receipt', { state: 'FINISHED', outcome: null, receipt: { kind: 'BUSINESS_REJECTION', code: 'PROJECT_NOT_FOUND', effect: 'NONE' } }, 'No task was added by this customization.'],
  ['declared NONE effect', { state: 'FINISHED', outcome: { classification: 'BUSINESS_REJECTION', effects: [{ state: 'NONE' }] }, receipt: null }, 'No task was added by this customization.'],
  ['UNKNOWN outcome with a NONE receipt', { state: 'FINISHED', outcome: { classification: 'UNCERTAIN', effects: [{ state: 'UNKNOWN' }] }, receipt: { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', effect: 'NONE' } }, 'Could not confirm whether a task was added.'],
  ['finished without an outcome', { state: 'FINISHED', outcome: null, receipt: null }, 'Could not confirm whether a task was added.'],
  ['a result label without an effect ledger', { state: 'FINISHED', outcome: { classification: 'COMPLETED', result: { status: 'NO_OP' } }, receipt: null }, 'Could not confirm whether a task was added.'],
  ['not started', { state: 'PENDING', outcome: null, receipt: null }, 'This customization has not started yet.'],
  ['started without an established result', { state: 'STARTED', outcome: null, receipt: null }, 'Could not confirm whether a task was added.'],
  ['effect confirmation without a readable native receipt', { state: 'FINISHED', outcome: { classification: 'COMPLETED', effects: [{ state: 'CONFIRMED' }] }, receipt: null }, 'Could not confirm whether a task was added.'],
]) test(`native result copy preserves evidence for ${label}`, async ({ page, demo }) => {
  await enter(page, demo); const { source } = await nativeData(page);
  const writes = []; let reads = 0;
  const before = demo.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(new URL(request.url()).pathname); });
  await page.route('**/api/tasks/' + source.id + '/reaction', route => { reads++; return route.fulfill({ json: projection }); });
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Customization outcome', exact: true });
  await expect(result.getByRole('status')).toHaveText(expected);
  await expect(result.getByRole('button', { name: /^Open task:/ })).toHaveCount(0);
  const beforeCheck = reads;
  await result.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(beforeCheck);
  await expect(result.getByRole('button', { name: 'Check result', exact: true })).toBeEnabled();
  await expect(result.getByRole('status')).toHaveText(expected);
  expect(writes).toEqual(['/api/tasks/' + source.id + '/complete']);
  expect(demo.db.prepare('SELECT status FROM tasks WHERE id=?').get(source.id).status).toBe('completed');
  expect(demo.db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(before);
});

test('a confirmed task stays visible when the customization later fails and technical evidence stays in details', async ({ page, demo }) => {
  await enter(page, demo); const { source, created } = await nativeData(page);
  const original = { classification: 'FAILED', error: { code: 'EXPRESSION_FAILED' }, effects: [{ state: 'CONFIRMED' }] };
  let completions = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/' + source.id + '/complete') completions++; });
  await page.route('**/api/tasks/' + source.id + '/reaction', route => route.fulfill({ json: { state: 'FINISHED', outcome: original,
    receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: created.id } } } }));
  await page.getByRole('button', { name: 'Complete ' + source.title, exact: true }).click();
  const result = page.getByRole('region', { name: 'Customization outcome', exact: true });
  await expect(result.getByRole('status')).toHaveText('Created “' + created.title + '”');
  await expect(result).toContainText('The customization did not finish successfully. Your completed task is kept.');
  const open = result.getByRole('button', { name: 'Open task: ' + created.title, exact: true });
  await expect(open).toBeVisible(); await expect(open).toHaveText('Open task');
  await expect(result.getByLabel('Original runtime outcome', { exact: true })).toBeHidden();
  await expect(result.getByLabel('Saved native receipt', { exact: true })).toBeHidden();
  await result.getByText('Result details', { exact: true }).click();
  await expect(result.getByLabel('Original runtime outcome', { exact: true })).toContainText('EXPRESSION_FAILED');
  await expect(result.getByLabel('Saved native receipt', { exact: true })).toContainText(created.id);
  await result.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(result.getByRole('status')).toHaveText('Created “' + created.title + '”');
  expect(completions).toBe(1); expect(demo.db.prepare('SELECT status FROM tasks WHERE id=?').get(source.id).status).toBe('completed');
});
