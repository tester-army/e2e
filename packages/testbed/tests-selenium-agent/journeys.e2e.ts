import { test, expect, credentials } from 'e2e';
import { z } from 'zod';

/**
 * Multi-step flows where the agent has to keep its bearings across navigation,
 * an unprompted promotion, and a component tree with no ids: the coffee cart
 * SPA, the calculator keypad, and a sign-in form whose labels are attached to
 * nothing.
 */
test.describe('coffee cart', () => {
  test('orders two drinks and reads the total back', async ({ app, agent, screen }) => {
    await app.open('/coffee/');
    // Anchor on the menu, not the chrome: the observation is taken the moment
    // the step runs, and this SPA paints the nav and the checkout button before
    // the drink list exists. Anchoring on the checkout button let the first
    // locate see a 10-node tree with no menu in it.
    await expect(screen.getByLabel('Espresso', { exact: true })).toBeVisible();

    await agent.tap('the Espresso cup');
    await agent.tap('the Cappuccino cup');

    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText(
      'Total: $29.00',
    );
    const order = await agent.extract('the cart count and the checkout total', {
      schema: z.object({ items: z.number().int(), total: z.string() }),
    });
    expect(order.items).toBe(2);
    expect(order.total).toContain('29');
  });

  test('dismisses an unprompted promotion mid-flow', async ({ app, agent, screen }) => {
    await app.open('/coffee/');

    await expect(screen.getByLabel('Espresso', { exact: true })).toBeVisible();
    for (const drink of ['Espresso', 'Cappuccino', 'Mocha']) {
      await agent.tap(`the ${drink} cup`);
    }
    // The promotion appears on its own and shifts the layout: the agent has to
    // notice a thing the test never mentioned.
    await agent.assert('the page is offering an extra discounted drink');
    await agent.tap('the button that declines the discounted offer');
    await expect(screen.getByRole('button', { name: 'Proceed to checkout' })).toHaveText(
      'Total: $37.00',
    );
  });

  test('completes checkout through the payment form', async ({ app, agent, screen }) => {
    await app.open('/coffee/');
    await expect(screen.getByLabel('Americano', { exact: true })).toBeVisible();

    await agent.tap('the Americano cup');
    await agent.tap('the checkout total button');
    await agent.type('the Name field', 'Ada Lovelace');
    await agent.type('the Email field', 'ada@example.com');
    await agent.tap('the Submit button');

    await expect(screen.getByText('Thanks for your purchase. Please check your email for payment.'))
      .toBeVisible();
    await agent.assert('the order was submitted and the cart is empty again');
  });
});

test.describe('calculator', () => {
  test('works the keypad by glyph', async ({ app, agent, web }) => {
    await app.open('/apps/calculator');

    await agent.tap('the 8 key');
    await agent.tap('the multiplication key');
    await agent.tap('the 9 key');
    await agent.tap('the equals key');

    await expect(web.locator('#output')).toHaveValue('72');
  });

  test('reads the display back', async ({ app, agent }) => {
    await app.open('/apps/calculator');

    await agent.tap('the 4 key');
    await agent.tap('the addition key');
    await agent.tap('the 5 key');
    await agent.tap('the equals key');
    const shown = await agent.extract('the number currently on the display', {
      schema: z.object({ value: z.number() }),
    });
    expect(shown.value).toBe(9);
  });
});

test.describe('sign in', () => {
  test('signs in with an opaque credential', async ({ app, agent, screen, web }) => {
    const demo = credentials.user('demo');
    await app.open('/simple/login');

    // Neither field has an accessible name: `<label for="">` binds to nothing,
    // so the deterministic suite addresses them by placeholder and id.
    await agent.type('the Username field', demo.username);
    await agent.type('the Password field', demo.password);
    await agent.tap('the Sign in button');

    await expect(web).toHaveURL(/\/simple\//);
    await expect(screen.getByRole('link', { name: 'Sign out' })).toBeVisible();
  });

  test('reports a rejected sign-in', async ({ app, agent, web }) => {
    await app.open('/simple/login');

    await agent.type('the Username field', 'gandalf');
    await agent.tap('the Sign in button');

    await expect(web.locator('#top_message')).toHaveText('Invalid Username!');
    await agent.assert('the page says the username is invalid');
  });
});
