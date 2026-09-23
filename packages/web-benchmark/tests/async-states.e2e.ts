import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { readCode } from './support.ts';

test.describe('async states', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/async-states');
    await expect(screen.getByTestId('initial-loading')).toBeVisible();
    await expect(screen.getByTestId('initial-loading')).toBeHidden();
  });

  test('reads the code off the transient toast and verifies it once the button enables', async ({
    screen,
  }) => {
    const verify = screen.getByRole('button', { name: 'Verify' });
    await expect(verify).toBeDisabled();

    await screen.getByRole('button', { name: 'Send code' }).tap();
    const toast = screen.getByTestId('toast');
    await expect(toast).toHaveText(/^Your code is \d{4}$/);
    const code = await readCode(toast, /\d{4}/);

    await screen.getByPlaceholder('Verification code').fill(code);
    await expect(verify).toBeEnabled();
    await verify.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Code verified successfully');
  });

  test('a wrong code is rejected after the toast has gone', async ({ screen }) => {
    await screen.getByRole('button', { name: 'Send code' }).tap();
    await expect(screen.getByTestId('toast')).toBeVisible();
    await expect(screen.getByTestId('toast')).toBeHidden();

    await screen.getByPlaceholder('Verification code').fill('0000');
    await screen.getByRole('button', { name: 'Verify' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText(
      'Wrong code - send it again and retry',
    );
  });
});
