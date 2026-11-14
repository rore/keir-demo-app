import { expect } from '@playwright/test';

export async function openDeveloperTools(page) {
  const tools = page.getByRole('region', { name: 'Customization Studio', exact: true }).locator('.rs-tools');
  await expect(tools).toBeVisible();
  const summary = tools.getByText('Developer tools', { exact: true });
  const disclosure = summary.locator('..');
  if (!await disclosure.evaluate(node => node.open)) await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);
  return disclosure;
}

export async function openSavedChanges(page) {
  const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const heading = studio.getByRole('heading', { name: 'Simulation', exact: true });
  const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
  const readOnly = decision.locator('.rs-review-status').filter({ hasText: 'read-only' });
  if (!await heading.isVisible() || await studio.locator('.rs-preview').isVisible() || await readOnly.isVisible())
    await studio.locator('#studio-view-saved').click();
  await expect(heading).toBeVisible();
  await expect(decision.locator('.rs-review-status')).not.toHaveText('Checking saved results…');
  if (await decision.locator('.rs-compact-case, .rs-workflow-case').count()) await expandCheckedExamples(decision);
  return decision;
}

export async function openSimulation(page) {
  const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const hide = studio.getByRole('button', { name: 'Hide simulation', exact: true });
  if (await hide.isVisible()) await hide.click();
  await studio.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(studio.getByRole('heading', { name: 'Simulation', exact: true })).toBeFocused();
  return openSavedChanges(page);
}

export async function expandCheckedExamples(decision) {
  const examples = decision.locator('.rs-compact-case, .rs-workflow-case');
  await expect(examples.first()).toBeVisible();
  for (const example of await examples.all()) {
    await expect(example).toBeVisible();
    const details = example.locator('.rs-case-disclosure');
    if (await details.count()) {
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      await expect(details).toHaveJSProperty('open', true);
    }
  }
}
