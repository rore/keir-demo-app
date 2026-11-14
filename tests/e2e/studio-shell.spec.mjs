import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';

for (const viewport of [{ width: 2000, height: 1040 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`opening and leaving Studio preserves the application frame at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    const name = 'Saved customization';
    admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name });
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const frame = () => page.evaluate(() => Object.fromEntries(['.workspace', '.workspace-top', '.rail'].map(selector => {
      const element = document.querySelector(selector), rect = element.getBoundingClientRect();
      return [selector, getComputedStyle(element).display === 'none' ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    })));
    const navigate = async destination => {
      if (viewport.width < 760) await page.locator('#destination-select').selectOption(destination.toLowerCase());
      else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: destination, exact: true }).click();
    };
    try {
      await page.setViewportSize(viewport);
      await page.goto(fixture.origin);
      await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      const original = await frame();
      expect(original['.workspace'].x).toBe(0);
      expect(original['.workspace'].width).toBe(viewport.width);
      await navigate('Customizations');
      const card = page.getByRole('article', { name, exact: true });
      await expect(card).toBeVisible();
      expect(await frame()).toEqual(original);
      await page.screenshot({ path: info.outputPath('collection.png') });
      await card.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(studio.getByRole('heading', { name, exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('existing-studio.png') });
      expect(await frame()).toEqual(original);
      expect((await studio.boundingBox()).width).toBeLessThanOrEqual(850);
      await expect(studio.getByRole('button', { name: 'Send', exact: true })).toHaveCount(1);
      await studio.getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep this unsent question.');
      await studio.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await expect(card).toBeVisible();
      expect(await frame()).toEqual(original);
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      await expect(studio.getByRole('heading', { name: 'New customization', exact: true })).toBeVisible();
      expect(await frame()).toEqual(original);
      expect((await studio.boundingBox()).width).toBeLessThanOrEqual(850);
      await studio.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(studio.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep this unsent question.');
      expect(await frame()).toEqual(original);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await navigate('Tasks');
      await expect(studio).toHaveCount(0);
      expect(await frame()).toEqual(original);
      expect(fixture.requests).toHaveLength(0);
    } finally { await page.close(); await fixture.close(); }
  });
}
