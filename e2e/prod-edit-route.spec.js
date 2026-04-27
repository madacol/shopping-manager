import test, { expect } from '@playwright/test';

const PROD_LIST_URL =
  process.env.E2E_PROD_LIST_URL ?? 'https://shop.babyjarvis.com/list.html?list=supermercado';

test('prod note save shows the saved note in the item', async ({ page }) => {
  await page.goto(PROD_LIST_URL, { waitUntil: 'networkidle' });

  const uniqueName = `prod-e2e-${Date.now()}`;

  await page.fill('#item-name', uniqueName);
  await page.fill('#item-qty', '1');
  await page.click('#add-form button[type="submit"]');

  const item = page.locator(`.item[data-item-name="${uniqueName}"]`);
  await expect(item).toBeVisible();

  await item.locator('.item-core').click();

  const editForm = item.locator('.edit-form');
  await expect(editForm).toBeVisible();

  await editForm.locator('input[name="note"]').fill('failing prod regression');
  await editForm.locator('button[type="submit"]').click();
  await expect(item).toContainText('failing prod regression');
});
