import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('first passing test', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', { name: 'Playground' })).toBeVisible();
});

test('second passing test', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('link', { name: 'Todos' })).toBeVisible();
});
