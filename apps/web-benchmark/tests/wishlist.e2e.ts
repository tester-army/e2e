import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';

/** The Save button of the shop row that names the product. */
function saveButton(screen: Screen, product: string): Locator {
  return screen
    .getByTestId('shop-list')
    .getByRole('listitem')
    .filter({ hasText: product })
    .getByRole('button');
}

test.describe('wishlist', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/wishlist');
  });

  test('saving toggles the button and the tab badge', async ({ screen }) => {
    const planner = saveButton(screen, 'Weekly Desk Planner');
    const pen = saveButton(screen, 'Brass Fountain Pen');
    await expect(screen.getByRole('button', { name: 'Wishlist (0)' })).toBeVisible();
    await expect(planner).toHaveText('♡ Save');

    await planner.tap();
    await expect(planner).toHaveText('♥ Saved');
    await expect(screen.getByRole('button', { name: 'Wishlist (1)' })).toBeVisible();

    await pen.tap();
    await expect(pen).toHaveText('♥ Saved');
    await expect(screen.getByRole('button', { name: 'Wishlist (2)' })).toBeVisible();

    await planner.tap();
    await expect(planner).toHaveText('♡ Save');
    await expect(screen.getByRole('button', { name: 'Wishlist (1)' })).toBeVisible();
  });

  test('the wishlist tab renders the empty state despite the badge count (planted bug)', async ({ screen }) => {
    await saveButton(screen, 'Weekly Desk Planner').tap();
    await saveButton(screen, 'Dot Grid Notebook').tap();
    await screen.getByRole('button', { name: 'Wishlist (2)' }).tap();

    await expect(screen.getByTestId('shop-list')).toBeHidden();
    await expect(screen.getByTestId('wishlist-empty')).toHaveText('No saved items yet.');
    await expect(screen.getByTestId('wishlist-panel')).not.toContainText('Weekly Desk Planner');
    await expect(screen.getByRole('button', { name: 'Wishlist (2)' })).toBeVisible();

    await screen.getByRole('button', { name: 'Shop' }).tap();
    await expect(saveButton(screen, 'Weekly Desk Planner')).toHaveText('♥ Saved');
    await expect(saveButton(screen, 'Brass Fountain Pen')).toHaveText('♡ Save');
  });
});
