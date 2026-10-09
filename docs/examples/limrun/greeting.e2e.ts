import { expect } from 'e2e';
import { test } from '@e2e-dev/mobile';

test('corrects an empty submission', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Enter a name first.', { exact: true })).toBeVisible();

  await screen.getByTestId('name').fill('Ada');
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).toBeVisible();
  await expect(screen.getByText('Enter a name first.', { exact: true })).not.toBeVisible();
  await app.screenshot('greeting');
});
