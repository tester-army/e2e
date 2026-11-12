import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// beforeAll and afterAll drive the app on a hook attempt of their own: what
// they leave in the browser stays in their context, never in a test's.
test.describe('suite hooks', { tags: ['hooks'] }, () => {
  test.beforeAll(async ({ app, screen, browser, platform }) => {
    expect(platform).toBe('web');
    await app.open('/');
    await browser.setCookies([{ name: 'session', value: 'admin', url: await browser.url(), httpOnly: true }]);
    await app.open('/dashboard');
    await expect(screen.getByRole('status', 'Greeting')).toContainText('admin');
  });

  test.afterAll(async ({ app, browser }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/login');
  });

  test('a sign-in from beforeAll does not reach the test', async ({ app, browser }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL('/login');
  });
});
