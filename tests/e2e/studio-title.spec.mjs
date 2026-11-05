import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

for (const viewport of [{ width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`long saved names leave the Studio header compact at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const name = 'Help me notice unfinished design work while keeping all my completed tasks unchanged'.slice(0, 80);
    try {
      const lifecycle = createLifecycle(fixture.db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) });
      const { extensionId } = admitTaskDraft(fixture.db, lifecycle, { name });
      let state = await lifecycle.compile('maya', { extensionId, hookId: 'TaskCompleted', source: fixture.metadata.source, label: name, draftVersion: 0 }, () => {});
      state = await lifecycle.proposeScenarios('maya', { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion, cases: fixture.metadata.cases }, () => {});
      const input = { extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion };
      state = await lifecycle.simulate('maya', input, () => {});
      expect(state.evidence.passed).toBe(true);
      state = lifecycle.approve('maya', { ...input, evidenceId: state.evidence.id }, () => {});
      lifecycle.activate('maya', { ...input, generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      await page.getByLabel('Destination', { exact: true }).selectOption('customizations');
      await page.getByRole('article', { name, exact: true }).getByRole('button', { name: /^(Open|Continue changes)$/, exact: true }).click();
      const heading = page.getByRole('heading', { name, exact: true });
      await expect(heading).toBeVisible();
      await expect(page.getByLabel('Customization status', { exact: true })).toContainText('On for my tasks');
      await expect(page.getByRole('region', { name: 'Customization Studio', exact: true })).not.toContainText('Simulation');
      const geometry = await heading.evaluate(node => ({ height: node.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(node).lineHeight), width: node.getBoundingClientRect().width }));
      expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
      expect(geometry.width).toBeGreaterThan(0);
      await expect(heading).toHaveAttribute('title', name);
      await expect(page.getByRole('button', { name: 'History and details', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Back to Customizations', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByLabel('Message to Daymark assistant', { exact: true })).toBeInViewport({ ratio: 1 });
      mkdirSync(resolve('build/studio-title'), { recursive: true });
      await page.screenshot({ path: resolve(`build/studio-title/${viewport.width}x${viewport.height}.png`) });
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}
