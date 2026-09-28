import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('buys a deal once the promo chrome is out of the way', async ({ app, screen }) => {
  await app.open('/e/promo-storefront');

  await screen.getByRole('button', { name: 'Accept' }).tap();
  await expect(screen.getByTestId('cookie-banner')).toBeHidden();

  await screen.getByRole('button', { name: 'Open support chat' }).tap();
  await expect(screen.getByTestId('chat-panel')).toContainText('Hi! How can we help?');
  await screen.getByRole('button', { name: 'Close' }).tap();
  await expect(screen.getByTestId('chat-panel')).toBeHidden();

  // The review skeletons resolve 1.2 s after load; the assertion waits them out.
  await expect(screen.getByTestId('reviews-section')).toContainText('Great bass');

  const headphones = screen.getByTestId('deal-headphones');
  await expect(headphones).toContainText('$80.00');
  await expect(headphones).toContainText('$40.00');
  await expect(headphones).toContainText('50% OFF');
  await expect(screen.getByTestId('deal-speaker')).toContainText('30% OFF');

  await headphones.getByRole('button', { name: 'Buy now' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Order confirmed');
  await expect(headphones.getByRole('button', { name: 'Buy now' })).toBeHidden();
  await expect(screen.getByTestId('deal-speaker').getByRole('button', { name: 'Buy now' })).toBeVisible();
});
