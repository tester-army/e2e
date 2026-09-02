import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

/**
 * Deterministic checks against stable public pages. Opt-in via
 * `pnpm --filter @e2edev/testbed test:public`; kept out of CI on purpose.
 */

test('example.com serves its reference page', async ({ app, screen, web }) => {
  await app.open();
  await expect(web).toHaveTitle('Example Domain');
  await expect(screen.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
  await expect(screen.getByRole('link', { name: /Learn more/ })).toBeVisible();
});

test('following the IANA reference link', async ({ app, screen, web }) => {
  await app.open();
  await screen.getByRole('link', { name: /Learn more/ }).tap();
  await expect(web).toHaveURL(/iana\.org/, { timeout: 15_000 });
});

test('playwright.dev navigation works', async ({ app, screen, web }) => {
  await app.deepLink('https://playwright.dev');
  await expect(web).toHaveTitle(/Playwright/);
  await screen.getByRole('link', { name: 'Get started' }).tap();
  await expect(web).toHaveURL(/docs\/intro/);
  await expect(screen.getByRole('heading', { name: 'Installation' })).toBeVisible();
});
