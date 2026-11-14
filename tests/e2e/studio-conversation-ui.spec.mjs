import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 600 }, { width: 390, height: 844 }]) {
  test(`one Send preserves real draft, active evidence and input through inline review at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000); await page.setViewportSize(viewport);
    // These are explicitly scripted test decisions, not a text classifier or a live-model qualification.
    const fixture = await startAuthoringFixture({ missingDue: true, intentResolutions: ['prepare', 'prepare', 'prepare', 'discuss',
      { intent: 'clarify', question: 'Do you want a draft change, or only to discuss it?' }] });
    const lifecycle = createLifecycle(fixture.db), errors = [];
    const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
    const composer = studio.getByLabel('Message to Daymark assistant', { exact: true });
    const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
    const send = async text => { await composer.fill(text); await studio.getByRole('button', { name: 'Send', exact: true }).click(); };
    const domain = () => Object.fromEntries(['tasks', 'extension_revisions', 'extension_authored', 'extension_evidence', 'extension_approvals', 'extension_selections']
      .map(name => [name, fixture.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(fixture.origin); await page.getByRole('button', { name: /^Continue as Maya/ }).click();
      if (viewport.width < 760) await page.locator('#destination-select').selectOption('customizations');
      else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Customizations', exact: true }).click();
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      await expect(studio.getByRole('button', { name: 'Send', exact: true })).toHaveCount(1);
      await expect(studio.getByRole('button', { name: 'Prepare changes', exact: true })).toHaveCount(0);
      await send('Prepare a rule to give new tasks a due date when they do not have one.');
      await expect(studio.getByText(fixture.metadata.question, { exact: true })).toBeVisible();
      await send('Confirmed: every project, only when the new task has no due date. Use exactly 168 hours after addition.');
      await expect(studio.getByText(fixture.metadata.offerText, { exact: true })).toBeVisible({ timeout: 30_000 });
      const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization'); expect(id).toBeTruthy();
      const checked = lifecycle.state('maya', id), originalSelection = checked.selection;
      await studio.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
      await expect(studio.locator('.rs-rule-summary')).toContainText('7 days');
      await expect(decision.getByRole('region', { name: 'Checked proposed behavior', exact: true }).getByRole('article')).toHaveCount(4);
      await decision.getByRole('button', { name: 'Approve this change', exact: true }).click();
      await expect(decision.getByRole('button', { name: 'Turn on for tasks added', exact: true })).toBeEnabled();
      expect(lifecycle.state('maya', id).selection).toEqual(originalSelection);
      await decision.getByRole('button', { name: 'Turn on for tasks added', exact: true }).click();
      await expect(studio.locator('#studio-view-active')).toContainText('7-day deadline');
      const active = lifecycle.state('maya', id).selection;
      await decision.getByRole('button', { name: 'Hide simulation', exact: true }).click();
      await send(fixture.metadata.editRequest);
      await expect(studio.getByText(fixture.metadata.editedOfferText, { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(lifecycle.state('maya', id).selection).toEqual(active);
      await expect(studio.locator('#studio-view-active')).toContainText('7-day deadline');
      await expect(studio.locator('#studio-view-saved')).toContainText('5-day deadline, not on');
      await expect(studio.locator('.rs-brief-summary')).toContainText('5 days');
      await expect(decision).toBeHidden();
      const snapshots = resolve('.tools/studio-conversation-ui/verified'); mkdirSync(snapshots, { recursive: true });
      await page.screenshot({ path: resolve(snapshots, `${viewport.width}x${viewport.height}-initial.png`) });
      const layout = await studio.evaluate(element => {
        const target = element.querySelector('#studio-title').getBoundingClientRect(), input = element.querySelector('.rs-composer').getBoundingClientRect();
        return { target: { top: target.top, bottom: target.bottom }, input: { top: input.top, bottom: input.bottom },
          transcript: element.querySelector('.rs-messages').clientHeight, viewport: innerHeight, width: document.documentElement.scrollWidth, font: getComputedStyle(element).fontSize };
      });
      expect(layout.font).toBe('16px'); expect(layout.target.top).toBeGreaterThanOrEqual(0); expect(layout.input.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(layout.width).toBeLessThanOrEqual(viewport.width); if (viewport.height === 600) expect(layout.transcript).toBeGreaterThan(256);
      await info.attach('actual-layout', { body: JSON.stringify(layout), contentType: 'application/json' });
      const beforeDiscussion = domain();
      await send('Could you explain why existing dates are kept?');
      await expect(studio.getByText(fixture.metadata.explanation, { exact: true })).toBeVisible(); expect(domain()).toEqual(beforeDiscussion);
      await studio.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(decision.getByRole('button', { name: 'Approve this change', exact: true })).toBeEnabled();
      await expect(studio.locator('.rs-rule-summary')).toContainText('5 days');
      await page.screenshot({ path: resolve(snapshots, `${viewport.width}x${viewport.height}-review.png`) });
      const unsent = 'Keep this unsent question\nabout weekends.'; await composer.fill(unsent);
      const beforeActive = domain(); await studio.locator('#studio-view-active').click();
      const current = studio.getByRole('article', { name: 'Version in use', exact: true });
      await expect(current).toContainText('7 days');
      await expect(current.getByLabel('Checked behavior in use', { exact: true })).toContainText('2027-01-07');
      await expect(current.getByLabel('Checked behavior in use', { exact: true })).not.toContainText('2027-01-05');
      await expect(current.getByRole('button', { name: /Approve|Turn on/ })).toHaveCount(0);
      await expect(composer).toHaveValue(unsent); expect(domain()).toEqual(beforeActive);
      await page.screenshot({ path: resolve(snapshots, `${viewport.width}x${viewport.height}-active.png`) });
      await current.getByRole('button', { name: 'Return to proposal', exact: true }).click(); await expect(composer).toHaveValue(unsent);
      await expect(studio.locator('#studio-view-active')).toBeFocused();
      await expect(studio.locator('.rs-rule-summary')).toContainText('5 days');
      await send('Yes');
      await expect(studio.getByText('Do you want a draft change, or only to discuss it?', { exact: true })).toBeVisible();
      expect(domain()).toEqual(beforeActive);
      expect(fixture.requests.filter(request => request.name === 'resolve_intent').map(request => request.intent)).toEqual(['prepare', 'prepare', 'prepare', 'discuss', 'clarify']);
      expect(errors).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });
}
