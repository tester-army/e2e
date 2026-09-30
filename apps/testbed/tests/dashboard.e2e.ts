import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('dashboard', { tags: ['auth'] }, () => {
  test('authenticated session reaches the dashboard directly', { session: 'admin' }, async ({ app, screen, browser }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/dashboard');
    await expect(screen.getByRole('status', 'Greeting')).toHaveText(
      'Welcome back, admin!',
    );
  });

  test('a session saved from a cookie reaches the dashboard directly', { session: 'admin-cookie' }, async ({ app, screen, browser }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/dashboard');
    await expect(screen.getByRole('status', 'Greeting')).toHaveText(
      'Welcome back, admin!',
    );
  });

  test('signing out invalidates the session', { session: 'admin' }, async ({ app, screen, browser }) => {
    await app.open('/dashboard');
    await screen.getByRole('link', 'Sign out').tap();
    await expect(browser).toHaveURL('/login');
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/login');
  });

  test('anonymous visitors are redirected to login', async ({ app, browser, screen }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/login');
    await expect(screen.getByRole('heading', 'Sign in')).toBeVisible();
  });

  test('wrong credentials surface an alert', async ({ app, screen }) => {
    await app.open('/login');
    await screen.getByLabel('Username').fill('admin');
    await screen.getByLabel('Password').fill('wrong-password');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByRole('alert')).toHaveText('Invalid credentials');
  });
});
