import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('accepts the terms once the button clears the sticky footer', async ({ app, screen }) => {
  await app.open('/e/sticky-chrome');
  await expect(screen.getByTestId('sticky-header')).toHaveText('Terms of Service');
  await expect(screen.getByTestId('success-message')).toBeHidden();

  const accept = screen.getByRole('button', { name: 'Accept terms' });
  await accept.scrollIntoView();
  await accept.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Terms accepted');

  const button = await accept.boundingBox();
  const footer = await screen.getByTestId('sticky-footer').boundingBox();
  if (button === null || footer === null) throw new Error('the button or the footer has no box');
  expect(button.y + button.height).toBeLessThanOrEqual(footer.y);
});
