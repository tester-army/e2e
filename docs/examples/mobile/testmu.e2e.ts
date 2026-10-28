import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('Proverbial home screen', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Proverbial')).toBeVisible();
  // Android labels the button GEOLOCATION, iOS GeoLocation.
  await expect(screen.getByRole('button', /^geolocation$/i)).toBeVisible();
});
