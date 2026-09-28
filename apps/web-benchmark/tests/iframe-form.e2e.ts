import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { readCode } from './support.ts';

test.describe('iframe form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/iframe-form');
  });

  test('a wrong code is refused by the host page', async ({ screen, web }) => {
    const checkout = web.frameLocator('iframe[title="checkout-frame"]');
    await checkout.getByPlaceholder('Coupon code').fill('SAVE-0000');
    await checkout.getByRole('button', { name: 'Apply' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Invalid coupon code');
  });

  test('the code read from one frame applies through the other', async ({ screen, web }) => {
    const coupon = web.frameLocator('iframe[title="coupon-frame"]').getByText(/Your coupon code:/);
    const code = await readCode(coupon, /[A-Z]+-\d+/);
    const checkout = web.frameLocator('iframe[title="checkout-frame"]');
    await checkout.getByPlaceholder('Coupon code').fill(code);
    await checkout.getByRole('button', { name: 'Apply' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Coupon applied');
  });
});
