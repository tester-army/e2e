import { test } from '@e2edev/mobile';
import { expect } from 'e2e';

test('Settings opens', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});
