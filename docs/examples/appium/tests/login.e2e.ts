import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('signs in', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('email').fill('ada@example.test');
  await screen.getByTestId('password').fill('hunter2');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByText('Welcome, Ada')).toBeVisible({ timeout: 10_000 });
});
