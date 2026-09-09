import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test.describe('filter deep link', () => {
  test('filtering writes the query to the URL', async ({ app, screen, web }) => {
    await app.open('/e/filter-deep-link');
    await screen.getByPlaceholder('Filter products').fill('mug');
    await expect(web).toHaveURL('/e/filter-deep-link?q=mug');
    await expect(screen.getByTestId('product-list')).toHaveText('Titanium Mug');
  });

  test('opening a shared link restores the filter', async ({ app, screen }) => {
    await app.open('/e/filter-deep-link?q=mug');
    await expect(screen.getByPlaceholder('Filter products')).toHaveValue('mug');
    await expect(screen.getByTestId('product-list')).toHaveText('Titanium Mug');
  });
});
