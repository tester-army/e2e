import { test } from '@e2edev/web';
import { expect } from 'e2e';

// Role names match exactly unless told otherwise; the home links' names carry
// the scenario description too, so these opt into substring matching.
test('home lists the scenarios and opens one', { tags: ['smoke'] }, async ({ app, screen, web }) => {
  await app.open();
  await expect(web).toHaveTitle('e2e Web Benchmark');
  await expect(screen.getByRole('heading', { name: 'Benchmark Examples' })).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Login Form', exact: false })).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Gift Card Purchase', exact: false })).toBeVisible();

  await screen.getByRole('link', { name: 'Login Form', exact: false }).tap();
  await expect(web).toHaveURL('/e/login-form');
  await expect(screen.getByRole('heading', { name: 'Login Form' })).toBeVisible();

  await screen.getByRole('link', { name: 'Benchmark Examples', exact: false }).tap();
  await expect(web).toHaveURL('/');
});
