import { test } from '@e2edev/web';
import { expect } from 'e2e';

// The accessible names are the trap here (aria-labels reading "undefined" and
// raw i18n keys), so the controls go by test id and placeholder.
test.describe('gift card purchase', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/gift-card-purchase');
  });

  test('refuses to buy without an amount', async ({ screen }) => {
    await screen.getByTestId('buy-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Choose a gift card amount');
  });

  test('refuses a recipient without an at sign', async ({ screen }) => {
    await screen.getByTestId('amount-10').tap();
    await screen.getByPlaceholder('friend@example.com').fill('friend');
    await screen.getByTestId('buy-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Enter a valid recipient email');
  });

  test('sends the gift card', async ({ screen }) => {
    await expect(screen.getByTestId('total-amount')).toHaveText('$0.00');
    await screen.getByTestId('amount-25').tap();
    await expect(screen.getByTestId('total-amount')).toHaveText('$25.00');
    await screen.getByPlaceholder('friend@example.com').fill('friend@example.com');
    await screen.getByTestId('buy-button').tap();
    await expect(screen.getByTestId('success-message')).toHaveText(
      'Gift card sent to friend@example.com',
    );
    await expect(screen.getByText('A $25.00 gift card is on its way.')).toBeVisible();
  });
});
