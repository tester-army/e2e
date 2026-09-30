import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('first passing test', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', 'Playground')).toBeVisible();
});

test('second passing test', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('link', 'Todos')).toBeVisible();
});
