import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('new tab flow', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/new-tab-flow');
  });

  test('reads the code in the tab the app opens and enters it back in the original tab', async ({ screen, browser }) => {
    const verification = await browser.waitForPopup(() => screen.getByTestId('open-tab-button').tap());
    await expect(browser).toHaveTitle('Verification');
    const code = await screen.getByText(/^TAB-\d+$/).textContent();
    await verification.close();
    await screen.getByTestId('code-input').fill(code ?? '');
    await screen.getByTestId('verify-button').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Verified successfully');
  });

  test('the screen follows the new tab on its own, and activate returns while it stays open', async ({ screen, browser }) => {
    await screen.getByTestId('open-tab-button').tap();
    await expect(screen.getByText('Verification code')).toBeVisible();
    const [original, verification] = browser.tabs();
    await original!.activate();
    await screen.getByTestId('code-input').fill('TAB-00000');
    await screen.getByTestId('verify-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong verification code');
    expect(verification!.isClosed()).toBe(false);
  });
});
