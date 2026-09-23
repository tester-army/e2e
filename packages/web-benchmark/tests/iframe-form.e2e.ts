import { test } from '@e2edev/web';
import type { Web } from '@e2edev/web';
import { expect } from 'e2e';

const CODE_PATTERN = /[A-Z]+-\d+/;

/** Reads the coupon code the first frame shows, the way a user would copy it. */
async function readCouponCode(web: Web): Promise<string> {
  const coupon = web
    .frameLocator('iframe[title="coupon-frame"]')
    .getByText('Your coupon code:', { exact: false });
  await expect(coupon).toContainText(CODE_PATTERN);
  const code = (await coupon.textContent())?.match(CODE_PATTERN)?.[0];
  if (code === undefined) throw new Error('the coupon frame shows no code');
  return code;
}

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
    const code = await readCouponCode(web);
    const checkout = web.frameLocator('iframe[title="checkout-frame"]');
    await checkout.getByPlaceholder('Coupon code').fill(code);
    await checkout.getByRole('button', { name: 'Apply' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Coupon applied');
  });
});
