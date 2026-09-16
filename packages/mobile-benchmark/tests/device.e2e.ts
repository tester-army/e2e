/**
 * Scenarios that need the engine's `device` fixture on top of locators: the
 * OS permission dialog, and a keyboard that covers the control to tap next.
 */

import type { Screen } from 'e2e';
import { expect, openScenario, test } from './fixtures.ts';

test.describe('permission prompt', () => {
  test.beforeEach(async ({ device, screen }) => {
    await device.setPermission('microphone', 'reset');
    await openScenario({ device, screen }, 'Permission Prompt');
  });

  test('allowing the system dialog enables the microphone', async ({ device, screen }) => {
    await screen.getByTestId('request-permission').tap();
    await device.alert('accept');
    await expect(screen.getByTestId('success-message')).toHaveText('Microphone enabled');
  });

  // Changing a permission terminates the app on iOS, so the grant made "in
  // settings" is picked up by a fresh visit rather than by Check again.
  test('a denied prompt recovers once the permission is granted outside', async ({ device, screen }) => {
    await screen.getByTestId('request-permission').tap();
    await device.alert('dismiss');
    await expect(screen.getByTestId('denied-banner')).toBeVisible();
    await device.setPermission('microphone', 'grant');
    await device.openApp('dev.e2e.benchmark', { relaunch: true });
    await openScenario({ device, screen }, 'Permission Prompt');
    await screen.getByTestId('request-permission').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Microphone enabled');
  });
});

/**
 * The wizard keeps the keyboard up on Return (`submitBehavior="submit"`) and
 * an iPhone keyboard has no dismiss key, so the keyboard goes the way a user
 * sends it away: a tap on the step's title, which the wizard's scroll view
 * turns into a dismissal.
 */
async function dismissKeyboardByTapping(screen: Screen, title: string): Promise<void> {
  await screen.getByText(title).tap();
}

// Every step auto-focuses its field, so the keyboard covers Continue from the
// start; the success screen echoes the values, so a stray key press fails it.
test('sequential onboarding echoes the exact values', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Sequential Onboarding');
  await screen.getByTestId('email-input').fill('jane@example.com');
  await dismissKeyboardByTapping(screen, 'Step 1 of 3');
  await screen.getByTestId('continue-button').tap();

  await screen.getByTestId('first-name-input').fill('Jane');
  await dismissKeyboardByTapping(screen, 'Step 2 of 3');
  await screen.getByTestId('last-name-input').fill('Merchant');
  await dismissKeyboardByTapping(screen, 'Step 2 of 3');
  await screen.getByTestId('continue-button').tap();

  await screen.getByTestId('phone-input').fill('0612435678');
  await dismissKeyboardByTapping(screen, 'Step 3 of 3');
  await screen.getByTestId('continue-button').tap();

  await expect(screen.getByTestId('success-message')).toHaveText('Onboarding complete');
  await expect(screen.getByTestId('echo-email')).toHaveText('jane@example.com');
  await expect(screen.getByTestId('echo-name')).toHaveText('Jane Merchant');
  await expect(screen.getByTestId('echo-phone')).toHaveText('0612435678');
});

test('onboarding rejects a malformed email before advancing', async ({ device, screen }) => {
  await openScenario({ device, screen }, 'Sequential Onboarding');
  await screen.getByTestId('email-input').fill('jane');
  await dismissKeyboardByTapping(screen, 'Step 1 of 3');
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByTestId('step-error')).toHaveText('Enter a valid email address');
  await expect(screen.getByTestId('onboarding-step-email')).toBeVisible();
});
