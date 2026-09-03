import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test.describe('dashboard', { tags: ['auth'] }, () => {
  test('authenticated session reaches the dashboard directly', { session: 'admin' }, async ({ app, screen, web }) => {
    await app.open('/dashboard');
    await expect(web).toHaveURL('/dashboard');
    await expect(screen.getByRole('status', { name: 'Greeting' })).toHaveText(
      'Welcome back, admin!',
    );
  });

  test('signing out invalidates the session', { session: 'admin' }, async ({ app, screen, web }) => {
    await app.open('/dashboard');
    await screen.getByRole('link', { name: 'Sign out' }).tap();
    await expect(web).toHaveURL('/login');
    await app.open('/dashboard');
    await expect(web).toHaveURL('/login');
  });

  test('anonymous visitors are redirected to login', async ({ app, web, screen }) => {
    await app.open('/dashboard');
    await expect(web).toHaveURL('/login');
    await expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('wrong credentials surface an alert', async ({ app, screen }) => {
    await app.open('/login');
    await screen.getByLabel('Username').fill('admin');
    await screen.getByLabel('Password').fill('wrong-password');
    await screen.getByRole('button', { name: 'Sign in' }).tap();
    await expect(screen.getByRole('alert')).toHaveText('Invalid credentials');
  });
});
