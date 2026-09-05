import { test } from '@e2edev/playwright';
import { expect, credentials } from '@e2edev/e2e';

/**
 * Each test fails on purpose in a way a reviewer can classify by hand, so the
 * analyzer's verdict has a ground truth to compare against. The expected
 * classification is in each title.
 */
test.describe('analysis fixtures', () => {
  test('[test-bug] expects stale wording after saving a profile', async ({ app, screen }) => {
    await app.open('/forms');
    await screen.getByLabel('Full name').fill('Ada Lovelace');
    await screen.getByRole('button', { name: 'Save profile' }).tap();
    // The app says "Saved profile for Ada Lovelace"; the test remembers an older copy.
    await expect(screen.getByRole('status', { name: 'Save result' })).toHaveText('Profile saved: Ada Lovelace');
  });

  test('[test-bug] looks for a control by a name the screen does not use', async ({ app, screen }) => {
    await app.open('/forms');
    await screen.getByRole('button', { name: 'Submit' }).tap();
  });

  test('[test-bug] asserts a greeting without signing in first', async ({ app, screen }) => {
    await app.open('/dashboard');
    await expect(screen.getByRole('status', { name: 'Greeting' })).toHaveText('Welcome back, admin!');
  });

  test('[app-bug] validation accepts an empty name', async ({ app, screen }) => {
    await app.open('/forms');
    await screen.getByLabel('Full name').fill('temp');
    await screen.getByLabel('Full name').clear();
    await screen.getByRole('button', { name: 'Save profile' }).tap();
    // The app correctly refuses; a product owner who expected a save sees this as the app's fault.
    await expect(screen.getByRole('status', { name: 'Save result' })).toHaveText('Saved profile for');
  });

  test('[app-bug or test-bug] wrong password shows a generic alert', async ({ app, screen }) => {
    await app.open('/login');
    await screen.getByLabel('Username').fill('admin');
    await screen.getByLabel('Password').fill('wrong-password');
    await screen.getByRole('button', { name: 'Sign in' }).tap();
    await expect(screen.getByRole('alert')).toHaveText('Wrong password for admin');
  });

  test('[secret filled] pixels stay out of the model after a credential fill', async ({ app, screen }) => {
    const admin = credentials.user('admin');
    await app.open('/login');
    await screen.getByLabel('Username').fill(admin.username);
    await screen.getByLabel('Password').fill(admin.password);
    await screen.getByRole('button', { name: 'Sign in' }).tap();
    await expect(screen.getByRole('status', { name: 'Greeting' })).toHaveText('Welcome, admin');
  });
});
