import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Role names match exactly unless told otherwise; the home links' names carry
// the scenario description too, so these opt into substring matching.
test('home lists the scenarios and opens one', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await app.open();
  await expect(browser).toHaveTitle('e2e Web Benchmark');
  await expect(screen.getByRole('heading', 'Benchmark Examples')).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Login Form', exact: false })).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Gift Card Purchase', exact: false })).toBeVisible();

  await screen.getByRole('link', { name: 'Login Form', exact: false }).tap();
  await expect(browser).toHaveURL('/e/login-form');
  await expect(screen.getByRole('heading', 'Login Form')).toBeVisible();

  await screen.getByRole('link', { name: 'Benchmark Examples', exact: false }).tap();
  await expect(browser).toHaveURL('/');
});
