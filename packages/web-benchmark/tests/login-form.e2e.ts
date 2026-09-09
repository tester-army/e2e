import { test } from '@e2edev/playwright';
import { expect, credentials } from '@e2edev/e2e';
import type { Credential } from '@e2edev/e2e';

test.describe('login form', () => {
  // The scenario's hardcoded account, declared once in e2e.config.ts. Every
  // "valid" value below comes from here; only the invalid ones are literals.
  let account: Credential;

  test.beforeEach(async ({ app }) => {
    account = credentials.user('benchmark');
    await app.open('/e/login-form');
  });

  test('rejects a malformed email', async ({ screen }) => {
    await screen.getByPlaceholder('Email').fill('not-an-email');
    await screen.getByPlaceholder('Password').fill(account.password);
    await screen.getByRole('button', { name: 'Log in' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Enter a valid email address');
  });

  test('rejects a short password', async ({ screen }) => {
    await screen.getByPlaceholder('Email').fill(account.username);
    await screen.getByPlaceholder('Password').fill('short');
    await screen.getByRole('button', { name: 'Log in' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText(
      'Password must be at least 8 characters',
    );
  });

  test('rejects an unknown account', async ({ screen }) => {
    await screen.getByPlaceholder('Email').fill('someone@example.com');
    await screen.getByPlaceholder('Password').fill(account.password);
    await screen.getByRole('button', { name: 'Log in' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Invalid credentials');
  });

  test('signs in and logs out', async ({ screen }) => {
    await screen.getByPlaceholder('Email').fill(account.username);
    await screen.getByPlaceholder('Password').fill(account.password);
    await screen.getByRole('button', { name: 'Log in' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Logged in successfully');

    await screen.getByRole('button', { name: 'Log out' }).tap();
    await expect(screen.getByPlaceholder('Email')).toHaveValue('');
    await expect(screen.getByRole('button', { name: 'Log in' })).toBeVisible();
  });
});
