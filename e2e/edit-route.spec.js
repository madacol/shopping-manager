import test, { expect } from '@playwright/test';

const LIST_URL =
  process.env.E2E_LIST_URL ?? 'http://127.0.0.1:3000/list.html?list=supermercado';

test('note save shows the saved note in the item', async ({ page }) => {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });

  const uniqueName = `shopping-e2e-${Date.now()}`;

  await page.fill('#item-name', uniqueName);
  await page.fill('#item-qty', '1');
  await page.click('#add-form button[type="submit"]');

  const item = page.locator(`.item[data-item-name="${uniqueName}"]`);
  await expect(item).toBeVisible();

  await item.locator('.item-core').click();

  const editForm = item.locator('.edit-form');
  await expect(editForm).toBeVisible();

  await editForm.locator('input[name="note"]').fill('saved from e2e');
  await editForm.locator('button[type="submit"]').click();
  await expect(item).toContainText('saved from e2e');
});
