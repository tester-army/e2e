/**
 * Locator-only runs through the scenarios whose semantics survive in the
 * accessibility tree: every control carries a test id, so no model is needed
 * to finish them. Each test is the deterministic floor the agentic suite's
 * `agent.act` must match.
 */

import { expect, openScenario, test } from './fixtures.ts';

test('text inputs unlock the submit button', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Text Input Variations');
  const submit = screen.getByTestId('submit-button');
  await expect(submit).toBeDisabled();
  await screen.getByTestId('username-input').fill('tester');
  await screen.getByTestId('pin-input').fill('1234');
  await screen.getByTestId('notes-input').fill('Notes long enough to count');
  await expect(submit).toBeEnabled();
  await submit.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Form submitted');
});

// An iOS text field without an accessibility label reports its text as both
// label and value, and the engine drops a value that echoes the label, so
// the value reads back empty today.
test('filled text inputs report their values', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Text Input Variations');
  await screen.getByTestId('username-input').fill('tester');
  await expect(screen.getByTestId('username-input')).toHaveValue('tester');
  await screen.getByTestId('notes-input').fill('Notes long enough to count');
  await expect(screen.getByTestId('notes-input')).toHaveValue('Notes long enough to count');
});

// The alert is the platform's own; it sits in the app's tree on both
// platforms as buttons named after the RN `Alert` options.
test('modal flow confirms through the native alert', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Modal Flow');
  await screen.getByTestId('open-modal-button').tap();
  await screen.getByTestId('continue-button').tap();
  await screen.getByRole('button', { name: 'Confirm' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Flow completed');
});

// Tab bar buttons carry the tab name plus position hints in their label,
// and the active one the selected state.
test('bottom tabs act inside the last tab', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Bottom Tabs');
  await expect(screen.getByTestId('home-tab-content')).toBeVisible();
  const home = screen.getByRole('button', { name: /Home/ });
  const actions = screen.getByRole('button', { name: /Actions/ });
  await expect(home).toBeSelected();
  await expect(actions).not.toBeSelected();
  await actions.tap();
  await expect(actions).toBeSelected();
  await expect(home).not.toBeSelected();
  await screen.getByTestId('complete-action-button').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Action completed');
});

test('error recovery retries, then confirms the delete', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Error Recovery');
  await expect(screen.getByTestId('error-banner')).toBeVisible();
  await screen.getByTestId('retry-button').tap();
  await screen.getByTestId('delete-draft').tap();
  await screen.getByTestId('confirm-delete').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Draft deleted');
});

test('choice controls place the exact order', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Choice Controls');
  await expect(screen.getByTestId('place-order')).toBeDisabled();
  await screen.getByTestId('size-medium').tap();
  await expect(screen.getByTestId('size-medium')).toBeSelected();
  await expect(screen.getByTestId('size-small')).not.toBeSelected();
  await screen.getByTestId('topping-cheese').tap();
  await screen.getByTestId('topping-olives').tap();
  await screen.getByTestId('rush-delivery').check();
  await expect(screen.getByTestId('rush-delivery')).toBeChecked();
  await expect(screen.getByTestId('place-order')).toBeEnabled();
  await screen.getByTestId('place-order').tap();
  await expect(screen.getByTestId('success-message')).toHaveText(
    'Order placed: Medium with Cheese, Olives (rush)',
  );
});

// The results list keeps the default keyboardShouldPersistTaps, so a tap
// with the keyboard open only dismisses it; Return blurs the field first.
test('debounced search selects the target once results arrive', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Debounced Search');
  await screen.getByTestId('search-input').fill('benchmark target');
  await screen.getByTestId('search-input').press('Enter');
  await screen.getByTestId('result-Benchmark Target').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Selected Benchmark Target');
});

test('infinite scroll reaches the target item', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Infinite Scroll List');
  const target = screen.getByTestId('item-137');
  await screen.scrollUntilVisible(target, { direction: 'down', timeout: 120_000 });
  await target.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Found item 137');
});

test('product catalog adds exactly two of the right variant', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Product Catalog');
  await screen.getByTestId('product-trail-mix-500').tap();
  await screen.getByTestId('quantity-increase').tap();
  await expect(screen.getByTestId('quantity-value')).toHaveText('2');
  await screen.getByTestId('add-to-cart').tap();
  await screen.getByTestId('open-cart').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Order ready: 2 × Trail Mix 500 g');
});

test('gestures: long-press, then swipe left', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Gestures');
  await screen.getByTestId('long-press-target').longPress({ duration: 1200 });
  await expect(screen.getByText('Step 2 of 3')).toBeVisible();
  // `direction` is the scroll direction: content to the right comes into
  // view when the finger moves left.
  await screen.getByTestId('swipe-target').swipe({ direction: 'right', momentum: 'fast' });
  await expect(screen.getByText('Step 3 of 3')).toBeVisible();
});

// `doubleTap()` reaches the app as one tap on iOS (controls.e2e.ts counts the
// taps that arrive), so the flow never gets past step 3.
test(
  'gestures: double-tap completes the flow',
  { skip: 'doubleTap delivers a single tap to the app on iOS' },
  async ({ device, screen }) => {
    await openScenario({ device, screen }, 'Gestures');
    await screen.getByTestId('long-press-target').longPress({ duration: 1200 });
    await screen.getByTestId('swipe-target').swipe({ direction: 'right', momentum: 'fast' });
    await screen.getByTestId('double-tap-target').doubleTap();
    await expect(screen.getByTestId('success-message')).toHaveText('All gestures completed');
  },
);

// The footer Continue button is a decoy until the terms are accepted; the
// accept button sits in the tree off screen from the first snapshot.
test('sticky chrome: accept below the fold, then continue', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Sticky Chrome Target');
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByText('Accept the terms at the bottom first')).toBeVisible();
  const accept = screen.getByTestId('accept-terms');
  await screen.scrollUntilVisible(accept, { direction: 'down' });
  await accept.tap();
  await expect(screen.getByText('Terms accepted ✓')).toBeVisible();
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Terms accepted');
});

test('async states: load, pull to refresh, claim through the toast', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Async States');
  await expect(screen.getByTestId('initial-loading')).toBeVisible();
  const content = screen.getByText('Pull down to refresh and reveal your reward');
  await expect(content).toBeVisible();
  // Pull to refresh is a long drag down from the top: a fast swipe toward
  // the content above, scoped to the scroll view so it spans most of it.
  await device.locator('role=ScrollView').swipe({ direction: 'up', momentum: 'fast' });
  await screen.getByTestId('claim-button').tap();
  await expect(screen.getByTestId('toast')).toBeVisible();
  await expect(screen.getByTestId('success-message')).toHaveText('Reward claimed');
});

// Row 512 is about 40 screens down and scrollUntilVisible pages one screen
// per swipe, so the test needs more than the default budget. Only the rows on
// screen enter the tree, so the count is a screenful, never the 600 loaded.
test('huge virtualized list reaches row 512', { timeout: 300_000 }, async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Huge Virtualized List');
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
// labels.
test('web view coupon form applies the code shown on the page', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'WebView Accessibility');
  // The page renders after the native screen; its semantics reach the tree
  // a few seconds later on a loaded machine.
  await expect(screen.getByText('TA-BENCH-50')).toBeVisible({ timeout: 20_000 });
  await screen.getByRole('textbox', { name: 'Coupon code' }).fill('TA-BENCH-50');
  await screen.getByRole('switch', { name: 'I accept the terms' }).tap();
  await screen.getByRole('button', { name: 'Apply coupon' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Coupon applied');
});
