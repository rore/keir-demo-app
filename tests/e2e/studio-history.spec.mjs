import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
async function api(page, path, body) {
  const session = await (await page.request.get(new URL('/api/session', page.url()).href)).json();
  const response = await page.request.fetch(new URL('/api/' + path, page.url()).href, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Session-Context': session.contextToken, origin: new URL(page.url()).origin }, data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 683, height: 384 }]) {
  const checked = viewport.width === 683;
  test(`${checked ? 'checked' : 'unchecked'} displaced changes remain discoverable and read-only after restart and reload (${viewport.width}px)`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
      const example = fixture.metadata;
      let state = await api(page, 'extensions', { operationId: crypto.randomUUID(), source: example.source, label: 'History integration' });
      const path = `extensions/${state.extension.id}`;
      const input = () => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
      state = await api(page, path + '/scenarios', { ...input(), cases: example.cases });
      state = await api(page, path + '/simulate', input());
      state = await api(page, path + '/approve', { ...input(), evidenceId: state.evidence.id });
      state = await api(page, path + '/activate', { ...input(), generation: state.selection.generation });
      const active = state.selection;
      const savedSource = example.source + '\n\n';
      state = await api(page, path + '/compile', { source: savedSource, label: 'Saved before restart', draftVersion: state.draftVersion });
      if (checked) {
        state = await api(page, path + '/scenarios', { ...input(), cases: example.cases });
        state = await api(page, path + '/simulate', input());
      }
      if (checked) expect(state.evidence.passed).toBe(true);
      else expect(state.evidence).toBeNull();
      expect(state.approved).toBe(false);
      const displaced = state;
      await page.goto(`${fixture.origin}/#customization=${state.extension.id}`);
      const ui = studio(page);
      await expect(ui.getByRole('heading', { name: 'History integration', exact: true })).toBeVisible();
      if (checked) await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
      const beginRestart = async () => {
        await ui.getByRole('button', { name: 'View what’s in use', exact: true }).click();
        await ui.getByRole('button', { name: 'Start changes from this version', exact: true }).click();
        const confirmation = ui.getByRole('article', { name: 'Start from version in use', exact: true });
        await expect(confirmation).toContainText(`version ${displaced.draftVersion}`);
        await expect(confirmation.getByRole('button', { name: 'Start from this version', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(ui.getByRole('article', { name: 'Current decision', exact: true })).toHaveCount(0);
        await expect(ui.getByLabel('Message to Studio', { exact: true })).toBeHidden();
        return confirmation;
      };
      await (await beginRestart()).getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await api(page, path)).toEqual(displaced);
      const confirmation = await beginRestart();
      const restarted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/' + path + '/restart');
      await confirmation.getByRole('button', { name: 'Start from this version', exact: true }).click();
      expect((await restarted).status()).toBe(200);
      const fresh = await api(page, path);
      expect(fresh.draft.id).not.toBe(displaced.draft.id);
      expect(fresh.selection).toEqual(active);
      expect(fresh.evidence).toBeNull();
      expect(fresh.approved).toBe(false);
      await page.reload();
      await expect(ui.getByRole('heading', { name: 'History integration', exact: true })).toBeVisible();
      await ui.getByRole('button', { name: 'History and details', exact: true }).click();
      await ui.getByText('Manage saved customization', { exact: true }).click();
      await ui.getByText('Selection history and exact identities', { exact: true }).click();
      const inspection = ui.getByRole('button', { name: 'Inspect earlier saved changes', exact: true });
      await expect(inspection).toHaveCount(1);
      await inspection.click();
      await expect(ui.getByRole('heading', { name: 'Earlier saved changes · read-only', exact: true })).toBeVisible();
      await expect(ui.getByLabel('Saved source for inspection', { exact: true })).toHaveText(savedSource);
      expect(await ui.getByLabel('Saved source for inspection', { exact: true }).textContent()).toBe(savedSource);
      await expect(ui.getByLabel('Compiled artifact for inspection', { exact: true })).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Approve this change', exact: true })).toHaveCount(0);
      await expect(ui.getByRole('button', { name: 'Turn on for my tasks', exact: true })).toHaveCount(0);
      const history = await api(page, path + '/history');
      expect(history.rows.find(row => row.operation === 'draft-superseded').revisionId).toBe(displaced.draft.id);
      expect(await api(page, path)).toEqual(fresh);
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}
