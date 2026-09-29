/**
 * The scenario flows that scroll, gesture, or wait: lists, the catalog,
 * swipes, long presses, refreshes, and the web view. Split from flows.e2e.ts
 * so two workers get about the same share of the suite's wall time.
 */

import { expect, openScenario, test } from './fixtures.ts';

test('infinite scroll reaches the target item', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Infinite Scroll List');
  const target = screen.getByTestId('item-137');
  await screen.scrollUntilVisible(target, { direction: 'down', timeout: 120_000 });
  await target.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Found item 137');
});

test('product catalog adds exactly two of the right variant', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Product Catalog');
  await screen.getByTestId('product-trail-mix-500').tap();
  await screen.getByTestId('quantity-increase').tap();
  await expect(screen.getByTestId('quantity-value')).toHaveText('2');
  await screen.getByTestId('add-to-cart').tap();
  await screen.getByTestId('open-cart').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Order ready: 2 × Trail Mix 500 g');
});

test('gestures: long-press, then swipe left', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Gestures');
  await screen.getByTestId('long-press-target').longPress({ duration: 1200 });
  await expect(screen.getByText('Step 2 of 3')).toBeVisible();
  // `direction` is the scroll direction: content to the right comes into
  // view when the finger moves left.
  await screen.getByTestId('swipe-target').swipe({ direction: 'right', momentum: 'fast' });
  await expect(screen.getByText('Step 3 of 3')).toBeVisible();
});

// `doubleTap()` is two presses 284 to 285 ms apart on iOS with agent-device
// 0.21.13 (controls.e2e.ts counts the taps that arrive), against the
// scenario's 300 ms window; Android lands the pair inside it.
test('gestures: double-tap completes the flow', { platforms: ['android'] }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Gestures');
  await screen.getByTestId('long-press-target').longPress({ duration: 1200 });
  await screen.getByTestId('swipe-target').swipe({ direction: 'right', momentum: 'fast' });
  await screen.getByTestId('double-tap-target').doubleTap();
  await expect(screen.getByTestId('success-message')).toHaveText('All gestures completed');
});

// The footer Continue button is a decoy until the terms are accepted; the
// accept button sits in the tree off screen from the first snapshot.
test('sticky chrome: accept below the fold, then continue', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sticky Chrome Target');
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByText('Accept the terms at the bottom first')).toBeVisible();
  const accept = screen.getByTestId('accept-terms');
  await screen.scrollUntilVisible(accept, { direction: 'down' });
  await accept.tap();
  await expect(screen.getByText('Terms accepted ✓')).toBeVisible();
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Terms accepted');
});

test('async states: load, pull to refresh, claim through the toast', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Async States');
  await expect(screen.getByTestId('initial-loading')).toBeVisible();
  const content = screen.getByText('Pull down to refresh and reveal your reward');
  await expect(content).toBeVisible();
  // Pull to refresh is a long drag down from the top: a fast swipe toward
  // the content above, scoped to the scroll view so it spans most of it. A
  // slow host drops the gesture now and then, so it is repeated until the
  // reward is on screen.
  const list = screen.getByTestId('reward-scroll');
  const claim = screen.getByTestId('claim-button');
  await expect
    .poll(async () => {
      if (await claim.isVisible()) return true;
      await list.swipe({ direction: 'up', momentum: 'fast' });
      return false;
    }, { timeout: 20_000 })
    .toBe(true);
  // The toast is gone within a couple of seconds, shorter than a snapshot
  // round trip on a slow machine; the message it leaves behind is the claim.
  // A tap that lands while the scroll view still settles from the refresh
  // stops the scroll instead of pressing the button, so a button still up
  // with no toast gets another tap; claiming twice claims once. That tap is
  // bounded: the button leaves the moment a claim lands.
  const toast = screen.getByTestId('toast');
  const claimed = screen.getByTestId('success-message');
  await claim.tap();
  await expect
    .poll(async () => {
      if (await claimed.isVisible()) return true;
      if ((await claim.isVisible()) && !(await toast.isVisible())) await claim.tap({ timeout: 1_000 });
      return false;
    }, { timeout: 10_000 })
    .toBe(true);
  await expect(claimed).toHaveText('Reward claimed');
});

// Row 512 is about 40 screens down and scrollUntilVisible pages one screen
// per swipe, so the test needs more than the default budget. Only the rows on
// screen enter the tree, so the count is a screenful, never the 600 loaded.
test('huge virtualized list reaches row 512', { timeout: 300_000 }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Huge Virtualized List');
  const rows = screen.getByTestId('huge-list').getByText(/^Row \d{4}$/);
  await expect(rows.first()).toHaveText('Row 0001');
  const onScreen = await rows.count();
  expect(onScreen).toBeGreaterThan(0);
  expect(onScreen).toBeLessThan(600);
  const target = screen.getByTestId('row-512');
  await screen.scrollUntilVisible(target, { direction: 'down', timeout: 240_000 });
  await target.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Found Row 0512');
});

// The web page's semantics project into the native tree: the input is a
// textbox, the checkbox a switch, the button a button, all named by their
// labels. On Android the field and the checkbox reach the tree unnamed: their
// `<label for>` is a labelled-by relation agent-device 0.21.15 does not carry,
// so the flow runs on iOS until it does.
test('web view coupon form applies the code shown on the page', { platforms: ['ios'] }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'WebView Accessibility');
  // The page renders after the native screen; its semantics reach the tree
  // a few seconds later on a loaded machine.
  await expect(screen.getByText('TA-BENCH-50')).toBeVisible({ timeout: 20_000 });
  await screen.getByRole('textbox', { name: 'Coupon code' }).fill('TA-BENCH-50');
  await screen.getByRole('switch', { name: 'I accept the terms' }).tap();
  await screen.getByRole('button', { name: 'Apply coupon' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Coupon applied');
});
