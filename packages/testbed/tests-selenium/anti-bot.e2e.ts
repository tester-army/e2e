import { test, expect } from 'e2e';

/**
 * seleniumbase.io/hobbit/login is an anti-bot page: it scores the client and
 * only then reveals a "Verify you are human" button and a sign-in link. The
 * reference driver never gets that far — a stock Playwright Chromium is
 * detected on load and redirected to a block page.
 *
 * This is a real limit of the driver, not of the site, so it is pinned rather
 * than hidden. When stealth launch options land, the first test here fails and
 * the second one becomes the suite.
 */
test.describe('anti-bot', { requires: ['web'] }, () => {
  test('the reference driver is detected and blocked', async ({ app, screen, web }) => {
    await app.open('/hobbit/login');

    // No polling loop needed: the redirect happens during load.
    await expect(web).toHaveURL(/hobbit\/gandalf/);
    await expect(web).toHaveTitle(/blocked you/);
    await expect(screen.getByText(/Access Denied/)).toBeVisible();
  });

  test(
    'a human-looking client reaches the sign-in form',
    { skip: 'the reference driver is detected before the page settles' },
    async ({ app, screen, web }) => {
      await app.open('/hobbit/login');

      await expect(screen.getByRole('button', { name: 'Verifying...' })).toBeVisible();
      await expect(screen.getByText('Verify you are human')).toBeVisible();
      await screen.getByRole('button', { name: 'Verify you are human' }).tap();
      await expect(screen.getByRole('link', { name: 'Sign in' })).toBeVisible();
      await expect(web).toHaveURL(/hobbit/);
    },
  );
});
