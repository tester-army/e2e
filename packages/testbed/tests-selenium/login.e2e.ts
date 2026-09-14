import { test } from '@e2edev/playwright';
import { expect, credentials } from 'e2e';

/**
 * seleniumbase.io/simple/login is a sign-in form with four distinct rejection
 * messages and a real credential to get past them. It is also a form with no
 * usable labels: every `<label>` on the page carries `for=""`, so the fields
 * are only addressable by placeholder or id even though a human reads them as
 * "Username" and "Password".
 */
test.describe('sign in', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/simple/login');
  });

  test('the fields have no accessible name', async ({ screen, web }) => {
    await expect(screen.getByRole('heading', { name: 'Simple Login Testing Page' })).toBeVisible();
    // The intended query — and the one an author reaches for first — matches
    // nothing, because `for=""` associates the label with no control.
    expect(await screen.getByLabel('Username').count()).toBe(0);
    await expect(screen.getByPlaceholder('Enter your username')).toBeVisible();
    await expect(web.locator('#password')).toBeVisible();
  });

  test('rejects an empty form', async ({ screen, web }) => {
    await screen.getByRole('link', { name: 'Sign in' }).tap();
    await expect(web.locator('#top_message')).toHaveText('The Username is Required!');
  });

  test('rejects an unknown user', async ({ screen, web }) => {
    await screen.getByPlaceholder('Enter your username').fill('gandalf');
    await screen.getByRole('link', { name: 'Sign in' }).tap();
    await expect(web.locator('#top_message')).toHaveText('Invalid Username!');
  });

  test('rejects a wrong password', async ({ screen, web }) => {
    await screen.getByPlaceholder('Enter your username').fill('demo_user');
    await screen.getByPlaceholder('Enter your password').fill('not-the-password');
    await screen.getByRole('link', { name: 'Sign in' }).tap();
    await expect(web.locator('#top_message')).toHaveText('Invalid Password!');
  });

  test('signs in with a configured credential', async ({ screen, web }) => {
    const demo = credentials.user('demo');

    await screen.getByPlaceholder('Enter your username').fill(demo.username);
    // The password stays opaque: it is a Secret, and only a sensitive sink
    // accepts one.
    await screen.getByPlaceholder('Enter your password').fill(demo.password);
    await screen.getByRole('link', { name: 'Sign in' }).tap();

    await expect(web).toHaveURL(/\/simple\//);
    await expect(screen.getByRole('link', { name: 'Sign out' })).toBeVisible();
    await expect(screen.getByText('Welcome!')).toBeVisible();
  });

  test('signing out returns to the form', async ({ screen, web }) => {
    const demo = credentials.user('demo');

    await screen.getByPlaceholder('Enter your username').fill(demo.username);
    await screen.getByPlaceholder('Enter your password').fill(demo.password);
    await screen.getByRole('link', { name: 'Sign in' }).tap();
    await expect(screen.getByRole('link', { name: 'Sign out' })).toBeVisible();

    await screen.getByRole('link', { name: 'Sign out' }).tap();
    await expect(web.locator('#top_message')).toHaveText('You have been signed out!');
  });
});
