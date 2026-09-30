import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('order history', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/order-history');
  });

  test('overview and settings render their panels', async ({ screen }) => {
    await expect(screen.getByTestId('overview-panel')).toContainText('Welcome back, Alex');
    await screen.getByRole('button', 'Settings').tap();
    await expect(screen.getByTestId('overview-panel')).toBeHidden();
    await expect(screen.getByTestId('settings-panel')).toContainText('Email: alex@example.com');
    await screen.getByRole('button', 'Overview').tap();
    await expect(screen.getByTestId('overview-panel')).toContainText(
      'You have 3 orders and 1 active subscription.',
    );
  });

  test('the orders tab never leaves its loading state (planted bug)', async ({ screen }) => {
    await screen.getByRole('button', 'Orders').tap();
    const orders = screen.getByTestId('orders-panel');
    // A negated matcher passes only after 1000 ms of continuous truth: the
    // dwell that tells a stuck loading state from a slow one.
    await expect(orders.getByText('Loading your orders...')).not.toBeHidden();
    await expect(orders.getByRole('listitem')).toHaveCount(0);

    await screen.getByRole('button', 'Settings').tap();
    await expect(screen.getByTestId('settings-panel')).toBeVisible();
    await screen.getByRole('button', 'Orders').tap();
    await expect(orders).toHaveText('Loading your orders...');
  });
});
