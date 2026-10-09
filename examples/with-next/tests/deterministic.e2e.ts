import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('shows the greeting form', async ({ app, screen }) => {
  await app.open('/');

  await expect(screen.getByRole('heading', 'Say hello')).toBeVisible();
  await expect(screen.getByLabel('Name')).toBeVisible();
});

test('asks for a name when the field is empty', async ({ app, screen }) => {
  await app.open('/');

  await screen.getByRole('button', 'Greet').click();

  // Next.js renders its own empty role=alert (the route announcer), so pick ours by its text.
  await expect(screen.getByRole('alert').filter({ hasText: 'Enter a name first.' })).toBeVisible();
});

test('greets the name you type', async ({ app, screen }) => {
  await app.open('/');

  await screen.getByLabel('Name').fill('Ada');
  await screen.getByRole('button', 'Greet').click();

  await expect(screen.getByRole('status')).toHaveText('Hello, Ada!');
});
