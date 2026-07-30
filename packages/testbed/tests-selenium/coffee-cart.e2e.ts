import { test, expect } from 'e2e';

/**
 * seleniumbase.io/coffee is a Vue SPA: client-side routing, a cart that only
 * exists in memory, an unprompted promotion that appears after the third item,
 * a `<dialog>` opened by a right click, and a toast that disappears on its own.
 *
 * Nothing here has a stable id worth using — the app is addressed the way its
 * author intended, by accessible name — so this is the file that says whether
 * the role/name surface is enough for a real component tree.
 */
test.describe('coffee cart', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/coffee/');
  });

  test('adds drinks and totals them', async ({ screen }) => {
    const total = screen.getByRole('button', { name: 'Proceed to checkout' });
    await expect(total).toHaveText('Total: $0.00');

    await screen.getByLabel('Espresso', { exact: true }).tap();
    await expect(total).toHaveText('Total: $10.00');
    await expect(screen.getByRole('link', { name: 'Cart page' })).toHaveText('cart (1)');

    await screen.getByLabel('Cappuccino').tap();
    await expect(total).toHaveText('Total: $29.00');
  });

  test('the cart page edits quantities', async ({ screen, web }) => {
    await screen.getByLabel('Espresso', { exact: true }).tap();
    await screen.getByLabel('Cappuccino').tap();
    await screen.getByRole('link', { name: 'Cart page' }).tap();
    await expect(web).toHaveURL(/\/coffee\/cart$/);

    await screen.getByRole('button', { name: 'Add one Espresso' }).tap();
    await expect(screen.getByText('$10.00 x 2')).toBeVisible();
    await screen.getByRole('button', { name: 'Remove one Espresso' }).tap();
    await expect(screen.getByText('$10.00 x 1')).toBeVisible();

    await screen.getByRole('button', { name: 'Remove all Cappuccino' }).tap();
    await expect(screen.getByText('Cappuccino')).toBeHidden();
    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText(
      'Total: $10.00',
    );
  });

  test('the third drink triggers an unprompted promotion', async ({ screen }) => {
    for (const drink of ['Espresso', 'Cappuccino', 'Mocha']) {
      await screen.getByLabel(drink, { exact: true }).tap();
    }
    // The promotion is not part of the flow the test asked for: it appears on
    // its own and shifts the layout under whatever the next step targets.
    await expect(screen.getByText(/lucky day/)).toBeVisible();
    await screen.getByRole('button', { name: "Nah, I'll skip." }).tap();
    await expect(screen.getByText(/lucky day/)).toBeHidden();
    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText('Total: $37.00');
  });

  test('accepting the promotion adds the discounted drink', async ({ screen }) => {
    for (const drink of ['Espresso', 'Cappuccino', 'Mocha']) {
      await screen.getByLabel(drink, { exact: true }).tap();
    }
    await screen.getByRole('button', { name: 'Yes, of course!' }).tap();
    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText('Total: $41.00');
  });

  test('checks out through the payment dialog', async ({ screen }) => {
    await screen.getByLabel('Espresso', { exact: true }).tap();
    await screen.getByRole('button', { name: 'Proceed to checkout' }).tap();

    await expect(screen.getByRole('heading', { name: 'Payment details' })).toBeVisible();
    await screen.getByLabel('Name').fill('Ada Lovelace');
    await screen.getByLabel('Email').fill('ada@example.com');
    await screen.getByLabel('Promotion checkbox').check();
    await screen.getByRole('button', { name: 'Submit' }).tap();

    await expect(screen.getByText(/Thanks for your purchase/)).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText('Total: $0.00');
  });

  test('the right-click dialog is out of reach', { skip: true }, async ({ screen }) => {
    // Right-clicking a cup opens `<dialog data-sb="add-to-cart-modal">`. The SDK
    // exposes only a primary pointer button — `Locator.tap`, `longPress`, and
    // `web.mouse.down` are all left-button — so this flow cannot be expressed
    // at all. Kept as the statement of the gap rather than deleted.
    await screen.getByLabel('Flat White').tap();
  });
});
