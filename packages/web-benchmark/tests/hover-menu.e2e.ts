import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('hover menu', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/hover-menu');
  });

  test('a decoy leaf is refused', async ({ screen }) => {
    await screen.getByText('Account').hover();
    await screen.getByText('Sign out').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('That is not the action');
  });

  test('hovering Account, then Billing, reaches Redeem voucher', async ({ screen }) => {
    await screen.getByText('Account').hover();
    await screen.getByText('Billing ›').hover();
    await screen.getByText('Redeem voucher').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Voucher redeemed');
  });
});
