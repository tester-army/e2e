import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('shows the greeting form', async ({ app, screen }) => {
  await app.open('/');

  await expect(screen.getByRole('heading', 'say hello')).toBeVisible();
  await expect(screen.getByLabel('name')).toBeVisible();
});

test('asks for a name when the field is empty', async ({ app, screen }) => {
  await app.open('/');

  await screen.getByRole('button', 'greet').click();

  await expect(screen.getByRole('alert')).toHaveText('enter a name first.');
});

test('greets the name you type', async ({ app, screen }) => {
  await app.open('/');

  await screen.getByLabel('name').fill('Ada');
  await screen.getByRole('button', 'greet').click();

  await expect(screen.getByRole('status')).toHaveText('hello, Ada!');
});
