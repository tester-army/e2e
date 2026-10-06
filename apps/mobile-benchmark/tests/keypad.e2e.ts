import { expect, openScenario, test } from './fixtures.ts';

test.describe('keypad', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Keypad');
  });

  test('saves the entered amount', async ({ screen }) => {
    const amount = screen.getByTestId('keypad-amount');
    await expect(amount).toHaveAccessibleName('Amount 0 USD');

    await screen.getByLabel('7').tap();
    await screen.getByLabel('5').tap();
    await screen.getByLabel('0').tap();

    await expect(amount).toHaveAccessibleName('Amount 750 USD');
    await screen.getByRole('button', 'Save').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Saved 750 USD');
  });

  test('accepts one decimal point and deletes the last digit', async ({ screen }) => {
    const amount = screen.getByTestId('keypad-amount');

    await screen.getByLabel('1').tap();
    await screen.getByLabel('Decimal point').tap();
    await screen.getByLabel('2').tap();
    await screen.getByLabel('Decimal point').tap();
    await expect(amount).toHaveAccessibleName('Amount 1.2 USD');

    await screen.getByLabel('Delete digit').tap();
    await expect(amount).toHaveAccessibleName('Amount 1. USD');
    await screen.getByLabel('5').tap();
    await expect(amount).toHaveAccessibleName('Amount 1.5 USD');

    await screen.getByRole('button', 'Save').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Saved 1.5 USD');
  });
});
