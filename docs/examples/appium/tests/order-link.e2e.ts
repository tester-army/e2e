import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('opens an order from a link', async ({ app, device, screen }) => {
  await device.setPermission('location', 'grant');
  await app.open();
  await device.openLink('myapp://orders/42');
  await expect(screen.getByText('Order #42')).toBeVisible();
});
