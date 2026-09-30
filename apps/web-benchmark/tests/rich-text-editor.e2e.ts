import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';

/** Types the phrase, then selects its last `length` characters with the keyboard. */
async function typeAndSelectTail(screen: Screen, browser: Browser, length: number) {
  await screen.getByTestId('editor').tap();
  await browser.keyboard.type('release approved');
  for (let i = 0; i < length; i += 1) {
    await browser.keyboard.press('Shift+ArrowLeft');
  }
}

test.describe('rich text editor', () => {
  test('bolding exactly the required word passes the check', async ({ app, screen, browser }) => {
    await app.open('/e/rich-text-editor');
    await typeAndSelectTail(screen, browser, 'approved'.length);
    await screen.getByRole('button', 'B').tap();
    await screen.getByRole('button', 'Check document').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Document approved');
  });

  test('bold that spills into the previous word fails the check', async ({ app, screen, browser }) => {
    await app.open('/e/rich-text-editor');
    await typeAndSelectTail(screen, browser, 'se approved'.length);
    await screen.getByRole('button', 'B').tap();
    await screen.getByRole('button', 'Check document').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Only the word approved must be bold');
  });
});
