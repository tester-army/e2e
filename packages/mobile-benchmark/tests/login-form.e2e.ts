import { credentials } from 'e2e';
import type { Credential } from 'e2e';
import { expect, openScenario, test } from './fixtures.ts';

test.describe('login form', () => {
  // The scenario's hardcoded account, declared once in e2e.config.ts. Every
  // "valid" value below comes from here; only the invalid ones are literals.
  let account: Credential;

  test.beforeEach(async ({ screen }) => {
    account = credentials.user('benchmark');
    await openScenario(screen, 'Login Form');
  });

  test('rejects a malformed email', async ({ screen }) => {
    await screen.getByTestId('email-input').fill('not-an-email');
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('login-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Enter a valid email address');
  });

  test('rejects an unknown account', async ({ screen }) => {
    await screen.getByTestId('email-input').fill('someone@example.com');
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('login-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Invalid credentials');
  });

  test('signs in and logs out', async ({ screen }) => {
    await screen.getByTestId('email-input').fill(account.username);
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('login-button').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Logged in successfully');

    await screen.getByTestId('logout-button').tap();
    await expect(screen.getByTestId('login-button')).toBeVisible();
  });
});
