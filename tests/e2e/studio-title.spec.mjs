import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

for (const viewport of [{ width: 390, height: 844 }, { width: 683, height: 384 }]) {
  test(`long saved names leave the Studio header compact at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const name = 'Help me notice unfinished design work while keeping all my completed tasks unchanged'.slice(0, 80);
    try {
      fixture.db.prepare('UPDATE extensions SET name=? WHERE owner_id=?').run(name, 'maya');
      expect(fixture.db.prepare('SELECT draft_revision_id FROM extensions WHERE owner_id=?').get('maya').draft_revision_id).toBeNull();
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: 'Continue as Maya' }).click();
      await page.getByLabel('Destination', { exact: true }).selectOption('customizations');
      await page.getByRole('article', { name, exact: true }).getByRole('button', { name: /^(Open|Continue changes)$/, exact: true }).click();
      const heading = page.getByRole('heading', { name, exact: true });
      await expect(heading).toBeVisible();
      await expect(page.getByText('This setup is in use.', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Customization Studio', exact: true })).not.toContainText('Your saved changes');
      const geometry = await heading.evaluate(node => ({ height: node.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(node).lineHeight), width: node.getBoundingClientRect().width }));
      expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
      expect(geometry.width).toBeGreaterThan(0);
      await expect(heading).toHaveAttribute('title', name);
      await expect(page.getByRole('button', { name: 'History and details', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Back to Customizations', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByLabel('Message to Studio', { exact: true })).toBeInViewport({ ratio: 1 });
      mkdirSync(resolve('build/studio-title'), { recursive: true });
      await page.screenshot({ path: resolve(`build/studio-title/${viewport.width}x${viewport.height}.png`) });
      expect(fixture.requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
}
