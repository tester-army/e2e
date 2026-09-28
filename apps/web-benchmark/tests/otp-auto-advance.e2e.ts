import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';

/** The segmented input at `index`, zero-based. */
function box(screen: Screen, index: number): Locator {
  return screen.getByTestId(`otp-input-${index}`);
}

test.describe('otp auto-advance', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/otp-auto-advance');
  });

  test('focus advances with each digit and the full code verifies', async ({ screen }) => {
    await box(screen, 0).pressSequentially('4');
    await expect(box(screen, 0)).toHaveValue('4');
    await expect(box(screen, 1)).toBeFocused();

    await box(screen, 1).pressSequentially('9302');
    await expect(box(screen, 4)).toHaveValue('2');
    await expect(box(screen, 5)).toBeFocused();

    await box(screen, 5).pressSequentially('7');
    await expect(screen.getByTestId('success-message')).toHaveText('Code verified');
  });

  test('backspace on an empty box clears and refocuses the previous one', async ({ screen }) => {
    await box(screen, 0).pressSequentially('49');
    await expect(box(screen, 2)).toBeFocused();
    await box(screen, 2).press('Backspace');
    await expect(box(screen, 1)).toHaveValue('');
    await expect(box(screen, 1)).toBeFocused();
    await expect(box(screen, 0)).toHaveValue('4');
  });

  test('a wrong code clears every box and starts over', async ({ screen }) => {
    await box(screen, 0).pressSequentially('000000');
    await expect(screen.getByTestId('error-message')).toHaveText('Incorrect code');
    await expect(box(screen, 0)).toBeFocused();
    for (let index = 0; index < 6; index += 1) {
      await expect(box(screen, index)).toHaveValue('');
    }

    await box(screen, 0).pressSequentially('493027');
    await expect(screen.getByTestId('success-message')).toHaveText('Code verified');
  });
});
