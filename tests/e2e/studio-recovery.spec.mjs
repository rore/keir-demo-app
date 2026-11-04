import { test, expect } from '@playwright/test';
import { openSavedChanges } from '../fixtures/studio-review.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const targetId = page => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
async function api(page, path, data) {
  const id = targetId(page);
  if (path === 'extensions' && data === undefined && id) path += `/${id}`;
  else if (/^extensions\/(scenarios|revisions|evidence)(\/|$)/.test(path)) {
    expect(id, 'A lifecycle read or mutation must name its saved customization.').toBeTruthy();
    path = path.replace('extensions/', `extensions/${id}/`);
  }
  const session = await (await page.request.get(new URL('/api/session', page.url()).href)).json();
  const response = await page.request.fetch(new URL(`/api/${path}`, page.url()).href, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Session-Context': session.contextToken, origin: new URL(page.url()).origin }, data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function navigateCustomizations(page) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
}
async function enter(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue as Maya' }).click();
  await navigateCustomizations(page);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
}
async function reopen(page) {
  const id = targetId(page);
  expect(id).toBeTruthy();
  await page.reload();
  await navigateCustomizations(page);
  await page.locator(`#edit-${id}`).click();
}
const stages = ['compile', 'scenarios', 'simulate'];
function observeStages(page, failure) {
  const attempted = Object.fromEntries(stages.map(stage => [stage, 0]));
  const accepted = { ...attempted };
  const reads = { state: 0, source: 0, example: 0 };
  page.on('request', request => {
    if (request.method() !== 'GET') return;
    const path = new URL(request.url()).pathname;
    if (/^\/api\/extensions(?:\/[^/]+|\/creation\/[^/]+)?$/.test(path)) reads.state++;
    if (/^\/api\/extensions\/[^/]+\/revisions\//.test(path)) reads.source++;
    if (path === '/api/authoring/example') reads.example++;
  });
  let interrupted = false;
  const ready = page.route(/\/api\/extensions(?:\/[^/]+\/(?:scenarios|simulate))?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    const stage = path === '/api/extensions' ? 'compile' : path.split('/').at(-1);
    if (route.request().method() !== 'POST') return route.continue();
    attempted[stage]++;
    const stop = !interrupted && failure?.stage === stage;
    if (stop) interrupted = true;
    if (stop && failure.kind === 'rejected') return route.fulfill({ status: 503, json: { message: 'Scenarios temporarily unavailable' } });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    accepted[stage]++;
    if (stop) return route.abort('failed');
    await route.fulfill({ response });
  });
  return { attempted, accepted, reads, ready };
}

for (const failure of [
  { stage: 'compile', kind: 'lost' },
  { stage: 'scenarios', kind: 'rejected' },
  { stage: 'scenarios', kind: 'lost' },
]) test(`guided example resumes only missing stages after ${failure.stage} ${failure.kind}`, async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enter(page, fixture.origin);
    const initial = await api(page, 'extensions'), example = await api(page, 'authoring/example');
    const calls = observeStages(page, failure);
    await calls.ready;
    const ui = studio(page);
    await ui.getByRole('button', { name: 'Try a guided example · no AI', exact: true }).click();
    await ui.getByRole('button', { name: 'Yes, keep Done for completed tasks', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Continue checking this example', exact: true })).toBeEnabled();
    expect(calls.reads.state).toBeGreaterThan(0);
    expect(calls.reads.source).toBeGreaterThan(0);
    const partial = await api(page, 'extensions');
    const documents = await api(page, `extensions/revisions/${partial.draft.id}`);
    expect(documents.source).toBe(example.source);
    expect(documents.cases).toEqual(failure.stage === 'scenarios' && failure.kind === 'lost' ? example.cases : []);
    expect(partial.approved).toBe(false);
    expect(partial.selection).toEqual(initial.selection);
    expect(partial.evidence).toBeNull();
    expect(calls.attempted).toEqual({ compile: 1, scenarios: failure.stage === 'scenarios' ? 1 : 0, simulate: 0 });
    expect(calls.accepted).toEqual({ compile: 1, scenarios: failure.stage === 'scenarios' && failure.kind === 'lost' ? 1 : 0, simulate: 0 });
    const beforeReentry = structuredClone(calls.attempted);
    const beforeReads = { ...calls.reads };
    await reopen(page);
    await ui.getByRole('button', { name: 'Continue guided example · no AI', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Continue checking this example', exact: true })).toBeEnabled();
    expect(calls.attempted).toEqual(beforeReentry);
    expect(calls.reads.example).toBeGreaterThan(beforeReads.example);
    expect(calls.reads.source).toBeGreaterThan(beforeReads.source);
    expect(await api(page, 'extensions')).toEqual(partial);
    await ui.getByRole('button', { name: 'Continue checking this example', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Continue checking this example', exact: true })).toHaveCount(0);
    await openSavedChanges(page);
    const decision = ui.getByRole('article', { name: 'Current decision', exact: true });
    await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
    const completed = await api(page, 'extensions');
    expect(completed.evidence.passed).toBe(true);
    expect(completed.approved).toBe(false);
    expect(completed.selection).toEqual(initial.selection);
    expect(calls.accepted).toEqual({ compile: 1, scenarios: 1, simulate: 1 });
    expect(calls.attempted).toEqual({ compile: 1, scenarios: failure.kind === 'rejected' ? 2 : 1, simulate: 1 });
    const exact = await api(page, `extensions/revisions/${completed.draft.id}`);
    expect(exact.source).toBe(example.source);
    expect(exact.cases).toEqual(example.cases);
    const proof = await api(page, `extensions/evidence/${completed.evidence.id}`);
    expect(proof.revisionId).toBe(completed.draft.id);
    expect(proof.reports).toHaveLength(5);
    expect(proof.reports.every(item => item.report.status === 'PASS')).toBe(true);
    await expect(decision.locator('.rs-example:visible')).toHaveCount(1);
    await decision.getByText(/^Other checked examples/).click();
    for (const label of ['Unfinished task', 'Completed task', 'Missing task', 'Task access denied', 'Read temporarily unavailable']) {
      const example = decision.getByRole('article', { name: `Example: ${label}`, exact: true });
      await expect(example).toBeVisible();
      await expect(example.getByText('Matches what you wanted', { exact: true })).toBeVisible();
    }
    await ui.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'View saved changes', exact: true }).first()).toBeFocused();
    expect((await api(page, 'extensions')).approved).toBe(false);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('guided recovery refuses matching source and label with different independent expectations', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await enter(page, fixture.origin);
    const initial = await api(page, 'extensions'), example = await api(page, 'authoring/example');
    const cases = example.cases.map((text, index) => {
      if (index) return text;
      const value = JSON.parse(text);
      value.expect.consumption = { status: 'NOT_DISPLAYED' };
      return JSON.stringify(value);
    });
    let prepared = await api(page, 'extensions', { operationId: crypto.randomUUID(), source: example.source, label: example.label });
    await page.goto(`${fixture.origin}/#customization=${prepared.extension.id}`);
    prepared = await api(page, 'extensions/scenarios', { revisionId: prepared.draft.id, cases, draftVersion: prepared.draftVersion });
    const calls = observeStages(page);
    await calls.ready;
    await reopen(page);
    const ui = studio(page);
    await ui.getByRole('button', { name: 'Continue guided example · no AI', exact: true }).click();
    await expect(ui.getByText('Continue this customization here. To try a separate guided example, choose New customization from the collection; this example will not replace your saved work.', { exact: true })).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Continue checking this example', exact: true })).toHaveCount(0);
    expect(await api(page, 'extensions')).toEqual(prepared);
    const exact = await api(page, `extensions/revisions/${prepared.draft.id}`);
    expect(exact.source).toBe(example.source);
    expect(exact.cases).toEqual(cases);
    expect(calls.attempted).toEqual({ compile: 0, scenarios: 0, simulate: 0 });
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
