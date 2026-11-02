import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('Wikipedia home screen', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Search Wikipedia').first()).toBeVisible();
});
