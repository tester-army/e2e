import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('continues only after the banner and the overlay are gone', async ({ app, screen }) => {
  await app.open('/e/overlay-trap');
  await screen.getByRole('button', { name: 'Accept cookies' }).tap();
  // The transparent overlay arrives half a second after load; its chip is the
  // only way to close it.
  await screen.getByRole('button', { name: 'close overlay', exact: false }).tap();
  await screen.getByRole('button', { name: 'Continue' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('You made it past the overlay');
});
