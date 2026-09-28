import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('app opens', async ({ app, web }) => {
  await app.open('/');
  await expect(web.locator('body')).toBeVisible();
});
