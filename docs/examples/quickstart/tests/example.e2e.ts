import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('app opens', async ({ app, web }) => {
  await app.open('/');
  await expect(web.locator('body')).toBeVisible();
});
