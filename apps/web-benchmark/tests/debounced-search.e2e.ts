import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('debounced search', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/debounced-search');
    // Every keystroke resets the debounce; the portal listbox opens once after
    // the last one plus the fake search round trip.
    await screen.getByRole('combobox').pressSequentially('trail mix');
    await expect(screen.getByRole('combobox')).toBeExpanded();
    await expect(screen.getByRole('option')).toHaveCount(5);
  });

  test('a decoy one character off is refused', async ({ screen }) => {
    await screen.getByRole('option', { name: 'Trail Mix 500 mg' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong item, look closer');
    await expect(screen.getByRole('listbox')).toBeVisible();
  });

  test('picking the exact item adds it to the cart', async ({ screen }) => {
    await screen.getByRole('option', { name: 'Trail Mix 500 g' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText(
      'Added Trail Mix 500 g to the cart',
    );
  });
});
