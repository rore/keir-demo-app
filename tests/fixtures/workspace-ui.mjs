import { expect } from '@playwright/test';

export async function navigate(page, name) {
  await page.getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name, exact: true }).click();
}

export async function openWorkspaceTool(page, selector) {
  const tool = page.locator(selector);
  if (!await tool.evaluate(node => node.open)) await tool.locator(':scope > summary').click();
  await expect(tool).toHaveJSProperty('open', true);
  return tool;
}

export async function switchPerson(page, person) {
  await openWorkspaceTool(page, '.user-tools');
  await page.getByLabel('Demo person', { exact: true }).selectOption(person);
}
