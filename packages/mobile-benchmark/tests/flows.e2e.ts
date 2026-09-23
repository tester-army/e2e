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
// label and value; the value is kept, since it is what a test reads.
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

// Tab bar buttons carry the tab name plus position hints in their label.
// The active tab shows in the content it reveals: its `selected` state only
// reaches the tree through the simulator's accessibility bridge, which a CI
// Mac does not always provide.
test('bottom tabs act inside the last tab', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Bottom Tabs');
  await expect(screen.getByTestId('home-tab-content')).toBeVisible();
  const home = screen.getByRole('button', { name: /Home/ });
  const actions = screen.getByRole('button', { name: /Actions/ });
  await expect(home).toBeVisible();
  await expect(screen.getByTestId('complete-action-button')).toHaveCount(0);
  await actions.tap();
  await expect(screen.getByTestId('complete-action-button')).toBeVisible();
  await expect(screen.getByTestId('home-tab-content')).toHaveCount(0);
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
  // The scenario's radios carry only `selected`, which reaches the tree
  // through the simulator's accessibility bridge alone; the order line at the
  // end is what says which size was chosen.
  await screen.getByTestId('size-medium').tap();
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
