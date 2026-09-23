import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';

/** The cart row for one product, found by the name it shows. */
function lineFor(screen: Screen, name: string): Locator {
  return screen.getByRole('listitem').filter({ hasText: name });
}

test.describe('cart totals', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/cart-totals');
  });

  test('increasing a quantity updates the line total but the order summary stays stale (planted bug)', async ({
    screen,
  }) => {
    await expect(screen.getByTestId('summary-subtotal')).toHaveText('$49.00');
    await expect(screen.getByTestId('summary-total')).toHaveText('$54.00');

    const tee = lineFor(screen, 'Organic Cotton Tee');
    await tee.getByRole('button', { name: '+' }).tap();
    await tee.getByRole('button', { name: '+' }).tap();
    await expect(screen.getByTestId('quantity-tee')).toHaveText('3');
    await expect(screen.getByTestId('line-total-tee')).toHaveText('$60.00');

    // Correct math would be $89.00 and $94.00; the summary never recomputes.
    await expect(screen.getByTestId('summary-subtotal')).toHaveText('$49.00');
    await expect(screen.getByTestId('summary-shipping')).toHaveText('$5.00');
    await expect(screen.getByTestId('summary-total')).toHaveText('$54.00');
  });

  test('a quantity never drops below one', async ({ screen }) => {
    const cap = lineFor(screen, 'Corduroy Cap');
    await cap.getByRole('button', { name: '-' }).tap();
    await expect(screen.getByTestId('quantity-cap')).toHaveText('1');
    await expect(screen.getByTestId('line-total-cap')).toHaveText('$29.00');
  });
});
