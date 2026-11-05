import { expect } from '@playwright/test';

export async function openSavedChanges(page) {
  const studio = page.getByRole('region', { name: 'Customization Studio', exact: true });
  const heading = studio.getByRole('heading', { name: 'Checked examples', exact: true });
  const latest = studio.getByRole('button', { name: 'View latest changes', exact: true }).first();
  if (await latest.isVisible()) await latest.click();
  else if (!await heading.isVisible() || await studio.locator('.rs-preview').isVisible())
    await studio.getByRole('button', { name: 'View saved changes', exact: true }).first().click();
  await expect(heading).toBeVisible();
  return studio.getByRole('article', { name: 'Current decision', exact: true });
}

export async function expandCheckedExamples(decision) {
  const examples = decision.locator('details:has(> .rs-example)');
  await expect(examples.first()).toBeVisible();
  for (const disclosure of await examples.all()) {
    if (!(await disclosure.evaluate(node => node.open))) await disclosure.locator(':scope > summary').click();
  }
}
