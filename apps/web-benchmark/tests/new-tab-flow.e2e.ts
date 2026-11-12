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

  test('a tap that opens a tab leaves the screen on the original tab, and activate shows the new one', async ({ screen, browser }) => {
    await screen.getByTestId('open-tab-button').tap();
    await screen.getByTestId('code-input').fill('TAB-00000');
    await screen.getByTestId('verify-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong verification code');
    await expect.poll(() => browser.tabs().length).toBe(2);
    const [original, verification] = browser.tabs();
    expect(original!.isActive()).toBe(true);
    await verification!.activate();
    await expect(browser).toHaveTitle('Verification');
  });
});
