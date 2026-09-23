import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('shows a raw greeting token and an undefined delivery date (planted bug), yet places the order', async ({
  app,
  screen,
}) => {
  await app.open('/e/checkout-review');
  await expect(screen.getByTestId('checkout-greeting')).toHaveText(
    'Thanks, {{firstName}}! Review your order below.',
  );
  await expect(screen.getByTestId('delivery-estimate')).toHaveText('Delivery: Arrives by undefined');
  await expect(screen.getByTestId('order-lines').getByRole('listitem')).toContainText([
    'Gooseneck Kettle x1',
    'Single Origin Beans 1kg x2',
  ]);
  await expect(screen.getByText('Ship to: 221B Baker Street, London')).toBeVisible();

  await screen.getByRole('button', { name: 'Place order - $123.00' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Order placed successfully');
  await expect(screen.getByText(/Order #10482/)).toBeVisible();
});
