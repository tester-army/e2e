import { test } from '@e2edev/mobile';
import { expect } from 'e2e';

test('Settings opens', async ({ screen }) => {
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});
