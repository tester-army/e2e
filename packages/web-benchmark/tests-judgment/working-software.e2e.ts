/**
 * The E2E Bench judgment track, clean side: assertions that are true of a
 * working scenario, including the two traps that look broken and are not
 * (Promo Storefront's overlays and chat widget, Gift Card Purchase's
 * "undefined" aria labels). Each test is expected to PASS. The bench buckets
 * by the `clean:` prefix: an ASSERTION_FAILED here is a false alarm, a pass
 * is a correct judgment, and any other failure is inconclusive.
 */

import { test } from '@e2edev/playwright';
import { credentials } from 'e2e';

test('clean: promo-storefront sells products behind its overlays', async ({ app, agent }) => {
  await app.open('/e/promo-storefront');
  await agent.act('dismiss any promotional overlay or popup that is in the way');
  await agent.assert('the storefront lists products for sale, each with a visible price and a way to add it to the cart');
});

test('clean: gift-card-purchase offers amounts and a recipient', async ({ app, agent }) => {
  await app.open('/e/gift-card-purchase');
  await agent.assert('the page offers gift card amounts to choose from and a field for the recipient');
});

test('clean: login-form signs the benchmark account in', async ({ app, agent }) => {
  const account = credentials.user('benchmark');
  await app.open('/e/login-form');
  await agent.act('log in with the given credentials', {
    params: { email: account.username, password: account.password },
  });
  await agent.assert('the page confirms that the login succeeded');
});

test('clean: sticky-chrome accepts the terms', async ({ app, agent }) => {
  await app.open('/e/sticky-chrome');
  await agent.act('scroll down to the accept button and accept the terms');
  await agent.assert('the page confirms that the terms were accepted');
});

test('clean: debounced-search finds trail mix', async ({ app, agent }) => {
  await app.open('/e/debounced-search');
  await agent.act('search for trail mix and add Trail Mix 500 g to the cart');
  await agent.assert('the page confirms that Trail Mix 500 g was added to the cart');
});

test('clean: date-picker opens a calendar', async ({ app, agent }) => {
  await app.open('/e/date-picker');
  await agent.act('open the date picker');
  await agent.assert('a calendar with a month grid of selectable days is showing');
});

test('clean: iframe-form splits the coupon across two frames', async ({ app, agent }) => {
  await app.open('/e/iframe-form');
  await agent.assert('one part of the page shows a coupon code and another part has a form to apply a coupon');
});

test('clean: hover-menu has an account menu', async ({ app, agent }) => {
  await app.open('/e/hover-menu');
  await agent.assert('the navigation includes an Account menu');
});
