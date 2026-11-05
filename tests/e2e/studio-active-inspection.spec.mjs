import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { TASK_HOOK, digest, json } from '../../src/extension-catalog.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';
import { readFileSync } from 'node:fs';
import { transaction } from '../../src/data.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const activeView = page => studio(page).getByRole('article', { name: 'Version in use', exact: true });
async function api(page, path, body) {
  const session = await (await page.request.get(new URL('/api/session', page.url()).href)).json();
  const response = await page.request.fetch(new URL('/api/' + path, page.url()).href, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: new URL(page.url()).origin, 'X-Session-Context': session.contextToken }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(page, fixture, activeAlternative = false) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
  const alternative = taskCustomizationFixture({ projectId: fixture.metadata.projectId, otherProjectId: fixture.metadata.otherProjectId, title: 'Plan customer next step' }).metadata;
  const current = activeAlternative ? alternative : fixture.metadata;
  const proposed = activeAlternative ? fixture.metadata : alternative;
  const activeTitle = current.title, draftTitle = proposed.title;
  const { extensionId } = admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name: 'Active inspection' });
  const path = 'extensions/' + extensionId;
  let state = await api(page, path + '/compile', { hookId: TASK_HOOK, source: current.source, label: 'Active inspection', draftVersion: 0 });
  const input = () => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
  state = await api(page, path + '/scenarios', { ...input(), cases: current.cases });
  state = await api(page, path + '/simulate', input());
  state = await api(page, path + '/approve', { ...input(), evidenceId: state.evidence.id });
  state = await api(page, path + '/activate', { ...input(), generation: state.selection.generation });
  const active = state.selection;
  expect(proposed.source).not.toBe(current.source); expect(draftTitle).not.toBe(activeTitle);
  state = await api(page, path + '/compile', { hookId: TASK_HOOK, source: proposed.source, label: 'New checked idea', draftVersion: state.draftVersion });
  state = await api(page, path + '/scenarios', { ...input(), cases: proposed.cases });
  state = await api(page, path + '/simulate', input());
  state = await api(page, path + '/approve', { ...input(), evidenceId: state.evidence.id });
  const draftProof = state.approvedEvidenceId;
  state = await api(page, path + '/simulate', input());
  expect(state.evidence.id).not.toBe(draftProof);
  expect(state.selection.approvedEvidenceId).toBe(active.approvedEvidenceId);
  await page.goto(`${fixture.origin}/#customization=${state.extension.id}`);
  await page.reload();
  await expect(studio(page).getByRole('heading', { name: 'Active inspection', exact: true })).toBeVisible();
  return { path, active, state, draftProof, activeTitle, draftTitle };
}
async function openActive(page) {
  await studio(page).getByRole('button', { name: 'View what’s in use', exact: true }).click();
}
async function openProof(page, id) {
  const ui = studio(page);
  await ui.getByRole('button', { name: 'History and details', exact: true }).click();
  const lookup = ui.getByText('Open a saved sample run by ID', { exact: true });
  if (!await lookup.evaluate(node => node.parentElement.open)) await lookup.click();
  await ui.getByLabel('Evidence ID for this person', { exact: true }).fill(id);
  await ui.getByRole('button', { name: 'Open saved sample run', exact: true }).click();
  const results = ui.getByRole('article', { name: 'Sample results', exact: true });
  await expect(results).toBeVisible();
  const details = results.locator('.rs-example-details > summary');
  if (!await details.evaluate(node => node.parentElement.open)) await details.click();
  return results;
}

// Restore exact archived effect/3 evidence for read-only inspection, without creating current execution authority.
function restoreHistoricalProof(db) {
  const load = name => readFileSync(new URL(`../fixtures/task-effect-3/${name}.json`, import.meta.url));
  const source = load('source'), artifact = load('artifact'), cases = JSON.parse(load('cases'));
  const saved = JSON.parse(load('reports')), { simulator, ...dependencies } = saved.identity;
  expect(saved.status).toBe('PASS'); expect(dependencies.profile).toBe('keir-effect/3');
  const suite = json(cases), pins = { ...dependencies, rawSourceDigest: digest(source),
    compiledSourceDigest: JSON.parse(artifact).sourceDigest, suiteDigest: digest(suite) };
  const identity = json(pins), versions = { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator };
  const suiteIdentity = digest(json({ ...versions, simulator: identity, cases: cases.map(text => ({ id: JSON.parse(text).id, digest: digest(text) })) }));
  const payload = json({ identity: { dependencies: pins, ...versions, suiteDigest: suiteIdentity }, reports: saved.reports });
  const extensionId = 'historical-inspection-item', revisionId = 'historical-inspection-revision', proofId = 'historical-inspection-proof';
  const lifecycle = createLifecycle(db);
  transaction(db, () => {
    lifecycle.admit('maya', { extensionId, operationId: extensionId, hash: digest(extensionId), name: 'Historical task customization' }, () => {});
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, 'maya', 'authored', identity, 'customer');
    db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revisionId, 'maya', 'Historical task customization', source, artifact, suite);
    db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, 'maya', extensionId);
    db.prepare('UPDATE extensions SET hook_id=?,draft_revision_id=?,draft_version=1 WHERE id=?').run(TASK_HOOK, revisionId, extensionId);
    db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run(proofId, 'maya', revisionId, identity, suiteIdentity, payload, 1);
    db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('maya', revisionId, proofId);
  });
  return { extensionId, revisionId, proofId, source, artifact, cases };
}

test('active behavior uses its approved proof and a failed reread cannot show cached draft or active results', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, active, state, draftProof, activeTitle, draftTitle } = await seed(page, fixture, true);
    const reads = [], mutations = [];
    page.on('request', request => { if (new URL(request.url()).pathname.includes('/evidence/')) reads.push(new URL(request.url()).pathname.split('/').at(-1)); });
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/extensions')) mutations.push(request.url()); });
    await openActive(page);
    await expect(activeView(page)).toContainText('Checked examples in use: 6.');
    await expect(activeView(page).getByLabel('Checked behavior in use', { exact: true })).toContainText(activeTitle);
    await expect(activeView(page).getByLabel('Checked behavior in use', { exact: true })).not.toContainText(draftTitle);
    const summary = await activeView(page).getByLabel('Checked behavior in use', { exact: true }).textContent();
    expect(summary).not.toContain('Example task:'); expect(summary).not.toContain('..');
    expect(summary.match(/No task was created\./g)).toHaveLength(1);
    expect(reads.at(-1)).toBe(active.approvedEvidenceId);
    expect(await api(page, path)).toEqual(state);
    await activeView(page).getByRole('button', { name: 'Continue saved changes', exact: true }).click();
    const beforeReview = reads.length;
    await openSavedChanges(page);
    const decision = studio(page).getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision.getByRole('heading', { name: 'Your saved changes', exact: true })).toBeVisible();
    const proposed = decision.getByRole('region', { name: 'Checked proposed behavior', exact: true });
    await expect(decision).toContainText('Checked examples: 6.');
    await expect(decision).toContainText('These were example tasks; your real tasks have not changed.');
    await expect(proposed.getByRole('article', { name: `Example: Completed task in “${fixture.metadata.projectName}”`, exact: true })).toBeVisible();
    await expect(proposed.locator('dd').first()).toContainText(draftTitle);
    await expect(proposed.locator('dd').nth(1)).toContainText(draftTitle);
    expect(reads.slice(beforeReview)).toContain(draftProof);
    expect(reads.slice(beforeReview)).not.toContain(state.evidence.id);
    await decision.getByText('Other checked examples (5)', { exact: true }).click();
    const missing = decision.getByRole('article', { name: 'Example: Missing task', exact: true });
    await expect(missing).toBeVisible();
    await expect(missing.locator('dd')).toHaveText(['Create no task.', 'No task was created. The source task could not be found.']);
    expect(await api(page, path)).toEqual(state);
    await studio(page).getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await page.route(`**/api/${path}/evidence/${active.approvedEvidenceId}`, route => route.fulfill({ status: 503, json: { message: 'Saved check unavailable' } }), { times: 1 });
    await openActive(page);
    await expect(activeView(page)).not.toContainText('Checked examples in use:');
    await expect(activeView(page)).toContainText(/could not|unavailable|not be confirmed/i);
    expect((await api(page, path)).selection).toEqual(active);
    expect(mutations).toEqual([]);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

for (const change of ['owner', 'selection']) test(`a late active proof cannot survive a changed ${change}`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  let release;
  try {
    const { path, active, state, activeTitle, draftTitle } = await seed(page, fixture);
    let started;
    const seen = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let finished;
    const settled = new Promise(resolve => { finished = resolve; });
    await page.route(`**/api/${path}/evidence/${active.approvedEvidenceId}`, async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      expect((await response.json()).revisionId).toBe(active.revision.id);
      started(); await held;
      try { await route.fulfill({ response }); } catch { /* A changed owner cancels the old view. */ }
      finished();
    }, { times: 1 });
    await openActive(page); await seen;
    if (change === 'owner') {
      await page.getByLabel('Demo person', { exact: true }).selectOption('sam');
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('sam');
    } else {
      await api(page, path + '/activate', { revisionId: state.draft.id, draftVersion: state.draftVersion, generation: active.generation });
    }
    release(); await settled;
    await expect(activeView(page).getByText(/Checked examples in use:/)).toHaveCount(0);
    if (change === 'owner') {
      await expect(page.getByRole('heading', { name: 'Active inspection', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Checked behavior in use', { exact: true })).toHaveCount(0);
      await expect(page.getByText(activeTitle, { exact: true })).toHaveCount(0);
    } else {
      await expect(activeView(page).getByRole('status')).toContainText(/changed/i);
      await openActive(page);
      await expect(activeView(page).getByLabel('Checked behavior in use', { exact: true })).toContainText(draftTitle);
      await expect(activeView(page).getByLabel('Checked behavior in use', { exact: true })).not.toContainText(activeTitle);
      expect((await api(page, path)).selection.revision.id).toBe(state.draft.id);
    }
    expect(fixture.requests).toHaveLength(0);
  } finally { release?.(); await fixture.close(); }
});

test('operator selection has an honest summary fallback without invented approval evidence', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const legacy = fixture.db.prepare(`SELECT l.extension_id FROM extension_selections s
      JOIN extension_revision_links l ON l.revision_id=s.revision_id AND l.owner_id=s.owner_id
      WHERE s.owner_id='maya' AND s.hook_id='ClassifyTask'`).get();
    const saved = await api(page, 'extensions/' + legacy.extension_id);
    expect(saved.retired).toBe(true);
    expect(saved.selection.revision.provenance).toBe('operator');
    expect(saved.selection.approvedEvidenceId).toBeNull();
    await page.goto(`${fixture.origin}/#customization=${saved.selection.revision.extensionId}`);
    await page.reload();
    const evidenceReads = [];
    page.on('request', request => { if (new URL(request.url()).pathname.includes('/evidence/')) evidenceReads.push(request.url()); });
    await openActive(page);
    await expect(activeView(page)).not.toContainText('Checked examples in use:');
    await expect(activeView(page)).toContainText(/operator|no saved|no verified/i);
    expect(evidenceReads).toEqual([]);
    expect(await api(page, 'extensions/' + legacy.extension_id)).toEqual(saved);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('an earlier revision, approved current run and newer current run retain distinct history labels', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, active, state, draftProof } = await seed(page, fixture);
    const ui = studio(page);
    await ui.getByRole('button', { name: 'History and details', exact: true }).click();
    const history = ui.getByText('Saved sample runs', { exact: true });
    await history.click();
    const entries = history.locator('..').locator('ol > li');
    for (const id of [active.approvedEvidenceId, draftProof, state.evidence.id]) {
      const index = state.evidenceHistory.findIndex(value => value.id === id);
      expect(index).toBeGreaterThanOrEqual(0);
      await expect(entries.nth(index).locator('small')).toContainText(id === state.evidence.id ? 'Current proposal' : 'Earlier run');
    }
    let results = await openProof(page, active.approvedEvidenceId);
    await expect(results.getByRole('heading', { name: 'Earlier examples', exact: true })).toBeVisible();
    await expect(results.getByText('Saved sample run · Earlier proposal', { exact: true })).toBeVisible();
    await expect(results.getByText('Latest run', { exact: true })).toHaveCount(0);
    await expect(results.getByText('Approved run', { exact: true })).toHaveCount(0);
    results = await openProof(page, draftProof);
    await expect(results.getByRole('heading', { name: 'Earlier examples', exact: true })).toBeVisible();
    await expect(results.getByText('Saved sample run · Earlier run for current proposal', { exact: true })).toBeVisible();
    await expect(results.getByText('Approved run', { exact: true })).toBeVisible();
    await expect(results.getByText('Latest run', { exact: true })).toHaveCount(0);
    results = await openProof(page, state.evidence.id);
    await expect(results.getByText('Saved sample run · Current proposal', { exact: true })).toBeVisible();
    await expect(results.getByText('Latest run', { exact: true })).toBeVisible();
    await expect(results.getByText('Approved run', { exact: true })).toHaveCount(0);
    expect(await api(page, path)).toEqual(state);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('genuine archived effect3 latest-head evidence is historical, never a current proposal or approval', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const old = restoreHistoricalProof(fixture.db);
    await page.goto(fixture.origin); await page.getByRole('button', { name: 'Continue as Maya' }).click();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    const path = 'extensions/' + old.extensionId, saved = await api(page, path);
    expect(saved.retired).toBe(true); expect(saved.evidence.id).toBe(old.proofId); expect(saved.approvedEvidenceId).toBe(old.proofId);
    expect(saved.selection.revision).toBeNull();
    const raw = await api(page, path + '/revisions/' + old.revisionId);
    expect(raw.source).toBe(old.source.toString('utf8')); expect(raw.artifact).toBe(old.artifact.toString('utf8')); expect(raw.cases).toEqual(old.cases);
    const proof = await api(page, path + '/evidence/' + old.proofId);
    expect(proof.passed).toBe(true);
    await page.goto(`${fixture.origin}/#customization=${old.extensionId}`);
    const ui = studio(page), mutations = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/extensions')) mutations.push(request.url()); });
    await ui.getByRole('button', { name: 'History and details', exact: true }).click();
    const history = ui.getByText('Saved sample runs', { exact: true }); await history.click();
    await expect(history.locator('..').locator('ol > li').first().locator('small')).toContainText('Earlier run');
    await expect(history.locator('..')).not.toContainText('Current proposal');
    const results = await openProof(page, old.proofId);
    await expect(results.getByRole('heading', { name: 'Earlier examples', exact: true })).toBeVisible();
    await expect(results.getByText('Saved sample run · Earlier proposal', { exact: true })).toBeVisible();
    await expect(results.getByText('Latest run', { exact: true })).toHaveCount(0);
    await expect(results.getByText('Approved run', { exact: true })).toHaveCount(0);
    await expect(results.getByRole('button', { name: /Approve|Turn on|Switch to/ })).toHaveCount(0);
    expect(await api(page, path)).toEqual(saved); expect(await api(page, path + '/evidence/' + old.proofId)).toEqual(proof);
    expect(mutations).toEqual([]); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('case display uses scenario facts and observed results despite misleading authored IDs and labels', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const { path, state, draftProof, draftTitle } = await seed(page, fixture, true);
    const original = await api(page, path + '/evidence/' + draftProof);
    expect(original.passed).toBe(true);
    // Display-only projection: retain the actual compiled proof's scenario, expected and observed results.
    await page.route(`**/api/${path}/evidence/${draftProof}`, async route => {
      const response = await route.fetch(), proof = await response.json();
      for (const [index, report] of proof.reports.entries()) {
        report.id = `completed-in-fabricated-project-${index}`;
        report.label = 'No task was created in the fabricated project';
      }
      await route.fulfill({ status: 200, json: proof });
    });
    const mutations = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/extensions')) mutations.push(request.url()); });
    await openSavedChanges(page);
    const decision = studio(page).getByRole('article', { name: 'Current decision', exact: true });
    const proposed = decision.getByRole('region', { name: 'Checked proposed behavior', exact: true });
    const completed = proposed.getByRole('article', { name: `Example: Completed task in “${fixture.metadata.projectName}”`, exact: true });
    await expect(completed).toBeVisible();
    await expect(completed.locator('dd').first()).toContainText(draftTitle);
    await expect(completed.locator('dd').nth(1)).toContainText(draftTitle);
    await expect(proposed).not.toContainText('fabricated project');
    await decision.getByText('Other checked examples (5)', { exact: true }).click();
    const missing = decision.getByRole('article', { name: 'Example: Missing task', exact: true });
    await expect(missing).toBeVisible();
    await expect(missing.locator('dd')).toHaveText(['Create no task.', 'No task was created. The source task could not be found.']);
    await expect(missing).not.toContainText('fabricated project');
    const denied = decision.getByRole('article', { name: 'Example: Task access unavailable', exact: true });
    await expect(denied.locator('dd')).toHaveText(['Create no task.', 'No task was created. The source task could not be checked because access was denied.']);
    const unavailable = decision.getByRole('article', { name: 'Example: Task temporarily unavailable', exact: true });
    await expect(unavailable.locator('dd')).toHaveText(['Create no task.', 'No task was created. The source task was temporarily unavailable.']);
    const unfinished = decision.getByRole('article', { name: `Example: Unfinished task in “${fixture.metadata.projectName}”`, exact: true });
    await expect(unfinished.locator('dd')).toHaveText(['Create no task.', 'No task was created.']);
    expect(await api(page, path)).toEqual(state);
    expect(await api(page, path + '/evidence/' + draftProof)).toEqual(original);
    expect(mutations).toEqual([]); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
