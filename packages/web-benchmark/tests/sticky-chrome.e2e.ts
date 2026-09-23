import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('accepts the terms once the button clears the sticky footer', async ({ app, screen }) => {
  await app.open('/e/sticky-chrome');
  await expect(screen.getByTestId('sticky-header')).toHaveText('Terms of Service');
  await expect(screen.getByTestId('success-message')).toBeHidden();

  await screen.getByRole('button', { name: 'Accept terms' }).tap();

  await expect(screen.getByTestId('success-message')).toHaveText('Terms accepted');
  await expect(screen.getByTestId('sticky-footer')).toBeVisible();
});
