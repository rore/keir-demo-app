import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { loadCatalog, loadHost, digest, json } from '../../src/extension-catalog.mjs';
import { simulationCases } from '../../src/extension-lifecycle.mjs';
import { transaction } from '../../src/data.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const originalCases = () => simulationCases('pending').filter(row => row.id !== 'host-denied').map(row => row.bytes.toString('utf8'));
const tables = ['extensions', 'extension_revision_links', 'extension_authored', 'extension_revisions', 'extension_selections',
  'extension_evidence', 'extension_approvals', 'extension_history', 'authoring_conversations', 'authoring_operations',
  'authoring_dispatches', 'authoring_budget', 'tasks', 'task_completion_events', 'task_effect_receipts'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));

// Original read2 source and compiled bytes are historical input, never relabeled or executed.
function historicalPartial(db, cases = null) {
  const item = loadCatalog().find(item => item.id === 'pending'), host = loadHost();
  const extensionId = crypto.randomUUID(), revisionId = crypto.randomUUID(), operationId = crypto.randomUUID();
  const label = 'Earlier guided example', source = Buffer.from(item.source), suite = cases === null ? null : json(cases);
  const identity = json({ ...host.pins, rawSourceDigest: digest(source), compiledSourceDigest: JSON.parse(item.artifactBytes).sourceDigest,
    artifactDigest: digest(item.artifactBytes), suiteDigest: suite === null ? null : digest(suite), fixture: 'task-advice-authored-fixtures/1' });
  transaction(db, () => {
    db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,creation_operation_id,creation_hash,draft_version,draft_revision_id) VALUES (?,?,?,?,?,?,?,0,NULL)')
      .run(extensionId, 'maya', 'ClassifyTask', label, Date.now(), operationId, digest(json({ operationId, source: item.source, label })));
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, 'maya', 'authored', identity, 'customer');
    db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revisionId, 'maya', label, source, item.artifactBytes, suite);
    db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, 'maya', extensionId);
    db.prepare('UPDATE extensions SET draft_revision_id=?,draft_version=? WHERE id=?').run(revisionId, cases === null ? 1 : 2, extensionId);
  });
  return { extensionId, revisionId, operationId, source: item.source, artifact: item.artifactBytes.toString('utf8'), cases: cases ?? [] };
}
async function api(page, path) {
  const origin = new URL(page.url()).origin, session = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request.get(origin + '/api/' + path, { headers: { 'X-Session-Context': session.contextToken } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function enter(page, origin) {
  await page.goto(origin); await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
}
async function collection(page) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
}
function observe(page) {
  const writes = [], lookups = [], reads = { source: 0, example: 0 };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && /^\/api\/(extensions|authoring)(\/|$)/.test(path)) writes.push(path);
    if (path.startsWith('/api/extensions/creation/')) lookups.push(path);
    if (request.method() === 'GET' && /^\/api\/extensions\/[^/]+\/revisions\//.test(path)) reads.source++;
    if (path === '/api/authoring/example') reads.example++;
  });
  return { writes, lookups, reads };
}
async function recover(page, saved, failure, calls) {
  const entryId = crypto.randomUUID(), key = 'daymark-studio-work:maya:' + entryId + ':example';
  await page.evaluate(({ key, operationId }) => sessionStorage.setItem(key, JSON.stringify({ operationId, personal: true })), { key, operationId: saved.operationId });
  let first = true;
  await page.route('**/api/extensions/creation/' + saved.operationId, async route => {
    if (!first || failure?.stage !== 'scenarios') return route.continue();
    first = false;
    if (failure.kind === 'rejected') return route.fulfill({ status: 503, json: { message: 'Historical receipt temporarily unavailable' } });
    const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true);
    await route.abort('failed');
  });
  const failedRead = failure?.stage !== 'scenarios' ? null : failure.kind === 'rejected'
    ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/extensions/creation/' + saved.operationId && response.status() === 503)
    : page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/extensions/creation/' + saved.operationId });
  await collection(page); await page.getByRole('button', { name: 'Check submitted example 1', exact: true }).click();
  const ui = studio(page);
  if (failure?.stage === 'scenarios') {
    await failedRead;
    await expect(ui.getByRole('button', { name: 'Check submitted example', exact: true })).toBeEnabled();
    await expect(ui.getByText('The earlier saved example was found.', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).not.toBeNull();
    await ui.getByRole('button', { name: 'Check submitted example', exact: true }).click();
  }
  await expect(ui).toContainText('The earlier saved example was found.');
  await expect(ui.getByRole('article', { name: 'Retired customization', exact: true })).toBeVisible();
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization')).toBe(saved.extensionId);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  expect(calls.lookups).toEqual(Array(failure?.stage === 'scenarios' ? 2 : 1).fill('/api/extensions/creation/' + saved.operationId));
}
async function inspect(page, saved) {
  const ui = studio(page);
  await ui.getByRole('button', { name: 'History and details', exact: true }).click();
  await ui.getByRole('button', { name: 'Inspect saved source and examples', exact: true }).click();
  await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText(saved.source);
  await expect(ui.getByLabel('Compiled artifact for inspection', { exact: true })).toHaveText(saved.artifact);
  if (!saved.cases.length) await expect(ui.getByText('Independent examples have not been saved for this source.', { exact: true })).toBeVisible();
  else for (const [index, text] of saved.cases.entries()) await expect(ui.getByLabel('Saved example ' + (index + 1) + ' for inspection', { exact: true })).toHaveText(text);
  await expect(ui.getByRole('button', { name: /^(Approve this change|Turn on for my tasks|Switch to this customization|Continue checking this example|Continue guided example · no AI)$/ })).toHaveCount(0);
}

for (const failure of [
  { stage: 'compile', kind: 'lost' },
  { stage: 'scenarios', kind: 'rejected' },
  { stage: 'scenarios', kind: 'lost' },
]) test('interrupted legacy ' + failure.stage + ' ' + failure.kind + ' recovers exact saved work read-only after reload and reopen', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const saved = historicalPartial(fixture.db, failure.stage === 'scenarios' && failure.kind === 'lost' ? originalCases() : null);
    await enter(page, fixture.origin);
    const before = await api(page, 'extensions/' + saved.extensionId), database = snapshot(fixture.db), calls = observe(page);
    await recover(page, saved, failure, calls); await inspect(page, saved);
    expect(calls.reads.source).toBeGreaterThan(0);
    const receiptReads = calls.lookups.length, sourceReads = calls.reads.source;
    await page.reload(); await expect(studio(page).getByRole('article', { name: 'Retired customization', exact: true })).toBeVisible();
    await inspect(page, saved);
    await collection(page); await page.locator('#edit-' + saved.extensionId).click(); await inspect(page, saved);
    expect(calls.lookups).toHaveLength(receiptReads); expect(calls.reads.source).toBeGreaterThan(sourceReads);
    const retained = await api(page, 'extensions/' + saved.extensionId);
    expect(retained).toEqual(before); expect(retained.approved).toBe(false); expect(retained.evidence).toBeNull();
    expect((await api(page, 'extensions/' + saved.extensionId + '/revisions/' + saved.revisionId)).cases).toEqual(saved.cases);
    expect(calls.writes).toEqual([]); expect(calls.reads.example).toBe(0); expect(fixture.requests).toEqual([]);
    expect(snapshot(fixture.db)).toEqual(database);
  } finally { await fixture.close(); }
});

test('legacy recovery keeps matching source and label with different independent expectations without replacing or approving them', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const originals = originalCases(), cases = originals.map((text, index) => {
      if (index) return text;
      const value = JSON.parse(text); value.expect.consumption = { status: 'NOT_DISPLAYED' };
      return JSON.stringify(value);
    });
    const saved = historicalPartial(fixture.db, cases);
    await enter(page, fixture.origin);
    const before = await api(page, 'extensions/' + saved.extensionId), database = snapshot(fixture.db), calls = observe(page);
    await recover(page, saved, undefined, calls); await inspect(page, saved);
    await page.reload(); await inspect(page, saved);
    await collection(page); await page.locator('#edit-' + saved.extensionId).click(); await inspect(page, saved);
    const exact = await api(page, 'extensions/' + saved.extensionId + '/revisions/' + saved.revisionId);
    expect(exact.source).toBe(loadCatalog().find(item => item.id === 'pending').source);
    expect(exact.cases).toEqual(cases); expect(exact.cases).not.toEqual(originals);
    expect(await api(page, 'extensions/' + saved.extensionId)).toEqual(before);
    expect(before.evidence).toBeNull(); expect(before.approved).toBe(false);
    expect(calls.lookups).toEqual(['/api/extensions/creation/' + saved.operationId]);
    expect(calls.writes).toEqual([]); expect(calls.reads.example).toBe(0); expect(fixture.requests).toEqual([]);
    expect(snapshot(fixture.db)).toEqual(database);
  } finally { await fixture.close(); }
});
