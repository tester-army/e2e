import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('saved addresses', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/saved-addresses');
  });

  test('adds an address and clears the form', async ({ screen }) => {
    const rows = screen.getByTestId('address-list').getByRole('listitem');
    await expect(rows).toHaveCount(2);

    await screen.getByPlaceholder('Label (e.g. Cabin)').fill('Cabin');
    await screen.getByPlaceholder('Street address').fill('7 Lakeview Trail, Bend');
    await screen.getByRole('button', 'Add address').tap();

    await expect(screen.getByTestId('toast')).toHaveText('Address saved');
    await expect(rows).toHaveCount(3);
    await expect(rows.last()).toHaveText('Cabin 7 Lakeview Trail, Bend Delete');
    await expect(screen.getByPlaceholder('Label (e.g. Cabin)')).toHaveValue('');
    await expect(screen.getByPlaceholder('Street address')).toHaveValue('');
  });

  test('ignores an add with an empty field', async ({ screen }) => {
    await screen.getByPlaceholder('Label (e.g. Cabin)').fill('Cabin');
    await screen.getByRole('button', 'Add address').tap();
    await expect(screen.getByTestId('toast')).toBeHidden();
    await expect(screen.getByTestId('address-list').getByRole('listitem')).toHaveCount(2);
    await expect(screen.getByPlaceholder('Label (e.g. Cabin)')).toHaveValue('Cabin');
  });

  test('delete shows its toast but keeps the address, on retry too (planted bug)', async ({ screen }) => {
    const rows = screen.getByTestId('address-list').getByRole('listitem');
    const home = screen.getByTestId('address-home');
    const remove = home.getByRole('button', 'Delete');

    await remove.tap();
    await expect(screen.getByTestId('toast')).toHaveText('Address deleted');
    await expect(home).toBeVisible();
    await expect(rows).toHaveCount(2);

    await remove.tap();
    await expect(home).toContainText('Home 12 Rosewood Lane, Portland');
    await expect(rows).toHaveCount(2);
  });
});
