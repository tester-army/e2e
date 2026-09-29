import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, screen, session, web }) => {
  const admin = credentials.user('admin');

  await app.open('/login');
  await screen.getByLabel('Username').fill(admin.username);
  await screen.getByLabel('Password').fill(admin.password);
  await screen.getByRole('button', { name: 'Sign in' }).tap();

  await expect(web).toHaveURL('/dashboard');
  await expect(screen.getByRole('status', { name: 'Greeting' })).toContainText('admin');

  await session.save('admin');
});

test.setup('authenticate as admin with a cookie', { sessions: ['admin-cookie'] }, async ({ app, screen, session, web }) => {
  // No secret is filled, so what restores this session keeps its screenshots.
  await app.open('/');
  await web.setCookies([{ name: 'session', value: 'admin', url: await web.url(), httpOnly: true }]);
  await app.open('/dashboard');

  await expect(web).toHaveURL('/dashboard');
  await expect(screen.getByRole('status', { name: 'Greeting' })).toContainText('admin');

  await session.save('admin-cookie');
});
