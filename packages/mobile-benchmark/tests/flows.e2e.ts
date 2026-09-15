/**
 * Locator-only runs through the scenarios whose semantics survive in the
 * accessibility tree: every control carries a test id, so no model is needed
 * to finish them. Each test is the deterministic floor the agentic suite's
 * `agent.act` must match.
 */

import { expect, openScenario, test } from './fixtures.ts';

test('text inputs unlock the submit button', async ({ screen }) => {
  await openScenario(screen, 'Text Input Variations');
  await screen.getByTestId('username-input').fill('tester');
  await screen.getByTestId('pin-input').fill('1234');
  await screen.getByTestId('notes-input').fill('Notes long enough to count');
  await screen.getByTestId('submit-button').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Form submitted');
});

// The alert is the platform's own; it sits in the app's tree on both
// platforms as buttons named after the RN `Alert` options.
test('modal flow confirms through the native alert', async ({ screen }) => {
  await openScenario(screen, 'Modal Flow');
  await screen.getByTestId('open-modal-button').tap();
  await screen.getByTestId('continue-button').tap();
  await screen.getByRole('button', { name: 'Confirm' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Flow completed');
});

// Tab bar buttons carry the tab name plus position hints in their label.
test('bottom tabs act inside the last tab', async ({ screen }) => {
  await openScenario(screen, 'Bottom Tabs');
  await expect(screen.getByTestId('home-tab-content')).toBeVisible();
  await screen.getByRole('button', { name: /Actions/ }).tap();
  await screen.getByTestId('complete-action-button').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Action completed');
});

test('error recovery retries, then confirms the delete', async ({ screen }) => {
  await openScenario(screen, 'Error Recovery');
  await expect(screen.getByTestId('error-banner')).toBeVisible();
  await screen.getByTestId('retry-button').tap();
  await screen.getByTestId('delete-draft').tap();
  await screen.getByTestId('confirm-delete').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Draft deleted');
});

test('choice controls place the exact order', async ({ screen }) => {
  await openScenario(screen, 'Choice Controls');
  await screen.getByTestId('size-medium').tap();
  await screen.getByTestId('topping-cheese').tap();
  await screen.getByTestId('topping-olives').tap();
  await screen.getByTestId('rush-delivery').check();
  await screen.getByTestId('place-order').tap();
  await expect(screen.getByTestId('success-message')).toHaveText(
    'Order placed: Medium with Cheese, Olives (rush)',
  );
});

test('debounced search selects the target once results arrive', async ({ screen }) => {
  await openScenario(screen, 'Debounced Search');
  await screen.getByTestId('search-input').fill('benchmark target');
  await screen.getByTestId('result-Benchmark Target').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Selected Benchmark Target');
});

test('infinite scroll reaches the target item', async ({ screen }) => {
  await openScenario(screen, 'Infinite Scroll List');
  const target = screen.getByTestId('item-137');
  await screen.scrollUntilVisible(target, { direction: 'down', timeout: 120_000 });
  await target.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Found item 137');
});
