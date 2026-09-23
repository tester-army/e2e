import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('price sorting', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/price-sorting');
  });

  test('opens in the featured order with sale prices struck through', async ({ screen }) => {
    const rows = screen.getByTestId('product-list').getByRole('listitem');
    await expect(rows).toHaveCount(5);
    await expect(rows).toContainText([
      'Trail Backpack 24L',
      'Steel Water Bottle',
      'Merino Hiking Socks',
      'Camp Lantern',
      'Titanium Mug',
    ]);
    await expect(screen.getByTestId('product-backpack')).toContainText('$120.00');
    await expect(screen.getByTestId('product-backpack')).toContainText('$49.00');
    await expect(screen.getByTestId('product-bottle')).toHaveText('Steel Water Bottle $25.00');
  });

  test('low to high sorts by the original price, not the paid one (planted bug)', async ({ screen }) => {
    const sort = screen.getByLabel('Sort by');
    await sort.selectOption({ value: 'price-asc' });
    await expect(sort).toHaveValue('price-asc');
    // Paid prices are socks 18, bottle 25, mug 12, lantern 54, backpack 49: a
    // correct sort opens with the $12 mug. The page sorts the struck prices.
    await expect(screen.getByTestId('product-list').getByRole('listitem')).toContainText([
      'Merino Hiking Socks',
      'Steel Water Bottle',
      'Titanium Mug',
      'Camp Lantern',
      'Trail Backpack 24L',
    ]);
  });

  test('high to low is the same wrong order reversed (planted bug)', async ({ screen }) => {
    const sort = screen.getByLabel('Sort by');
    await sort.selectOption({ value: 'price-desc' });
    await expect(sort).toHaveValue('price-desc');
    await expect(screen.getByTestId('product-list').getByRole('listitem')).toContainText([
      'Trail Backpack 24L',
      'Camp Lantern',
      'Titanium Mug',
      'Steel Water Bottle',
      'Merino Hiking Socks',
    ]);
    await sort.selectOption({ value: 'featured' });
    await expect(screen.getByTestId('product-list').getByRole('listitem').first()).toContainText(
      'Trail Backpack 24L',
    );
  });
});
