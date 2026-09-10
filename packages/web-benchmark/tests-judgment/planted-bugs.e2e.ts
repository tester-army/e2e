/**
 * The E2E Bench judgment track, bug side: on each bug-book scenario the test
 * asserts the behavior a working product would show, so a correct judgment
 * FAILS the test with ASSERTION_FAILED. The bench reads the outcome from the
 * report and buckets it by the `bug:` prefix on the title: a failed assertion
 * is a caught bug, a pass is a missed one, and any other failure is
 * inconclusive (the act did not reach the point of judgment). Run standalone,
 * this file is expected to be red.
 */

import { test } from '@e2edev/playwright';

test('bug: price-sorting sorts by the price actually charged', async ({ app, agent }) => {
  await app.open('/e/price-sorting');
  await agent.act('sort the products by price from low to high');
  await agent.assert('the products are listed in ascending order of the price a buyer pays now, using the sale price where one is shown');
});

test('bug: cart-totals keeps the summary in step with the lines', async ({ app, agent }) => {
  await app.open('/e/cart-totals');
  await agent.act('increase the quantity of the first item in the cart by two');
  await agent.assert('the subtotal and the order total in the summary equal the sum of the line totals');
});

test('bug: checkout-review renders its copy', async ({ app, agent }) => {
  await app.open('/e/checkout-review');
  await agent.assert('the greeting addresses the customer by a real first name and the delivery estimate names a date');
});

test('bug: saved-addresses removes a deleted address', async ({ app, agent }) => {
  await app.open('/e/saved-addresses');
  await agent.act('delete the first saved address in the address book');
  await agent.assert('the address that was deleted is no longer in the list of saved addresses');
});

test('bug: newsletter-signup answers a subscription', async ({ app, agent }) => {
  await app.open('/e/newsletter-signup');
  await agent.act('subscribe to the newsletter with the email tester@example.com');
  await agent.assert('the page shows a confirmation that the subscription succeeded, or an error explaining why it did not');
});

test('bug: order-history shows the orders', async ({ app, agent }) => {
  await app.open('/e/order-history');
  await agent.act('open the Orders tab');
  await agent.assert('the Orders tab shows a list of past orders, not a loading state');
});

test('bug: product-reviews match the product', async ({ app, agent }) => {
  await app.open('/e/product-reviews');
  await agent.assert('every customer review on the page is about the product the page sells');
});

test('bug: wishlist lists what was saved', async ({ app, agent }) => {
  await app.open('/e/wishlist');
  await agent.act('save the first product to the wishlist, then open the wishlist tab');
  await agent.assert('the wishlist tab lists the product that was just saved');
});
