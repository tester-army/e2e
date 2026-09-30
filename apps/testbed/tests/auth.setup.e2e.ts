import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, screen, session, browser }) => {
  const admin = credentials.user('admin');

  await app.open('/login');
  await screen.getByLabel('Username').fill(admin.username);
  await screen.getByLabel('Password').fill(admin.password);
  await screen.getByRole('button', 'Sign in').tap();

  await expect(browser).toHaveURL('/dashboard');
  await expect(screen.getByRole('status', 'Greeting')).toContainText('admin');

  await session.save('admin');
});

test.setup('authenticate as admin with a cookie', { sessions: ['admin-cookie'] }, async ({ app, screen, session, browser }) => {
  // No secret is filled, so what restores this session keeps its screenshots.
  await app.open('/');
  await browser.setCookies([{ name: 'session', value: 'admin', url: await browser.url(), httpOnly: true }]);
  await app.open('/dashboard');

  await expect(browser).toHaveURL('/dashboard');
  await expect(screen.getByRole('status', 'Greeting')).toContainText('admin');

  await session.save('admin-cookie');
});
