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
  const latest = studio.getByRole('button', { name: 'See current proposal', exact: true }).first();
  if (await latest.isVisible()) await latest.click();
  else if (!await heading.isVisible() || await studio.locator('.rs-preview').isVisible())
    await studio.getByRole('button', { name: 'See proposed change', exact: true }).first().click();
  await expect(heading).toBeVisible();
  const decision = studio.getByRole('article', { name: 'Current decision', exact: true });
  await expect(decision.locator('.rs-review-status')).not.toHaveText('Checking saved results…');
  if (await decision.locator('.rs-compact-case, .rs-workflow-case').count()) await expandCheckedExamples(decision);
  return decision;
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
