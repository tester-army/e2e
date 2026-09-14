import { test } from '@e2edev/playwright';
import type { Web } from '@e2edev/playwright';
import { expect } from 'e2e';
import type { Screen } from 'e2e';

/** Types the phrase, then selects its last `length` characters with the keyboard. */
async function typeAndSelectTail(screen: Screen, web: Web, length: number) {
  await screen.getByTestId('editor').tap();
  await web.keyboard.type('release approved');
  for (let i = 0; i < length; i += 1) {
    await web.keyboard.press('Shift+ArrowLeft');
  }
}

test.describe('rich text editor', () => {
  test('bolding exactly the required word passes the check', async ({ app, screen, web }) => {
    await app.open('/e/rich-text-editor');
    await typeAndSelectTail(screen, web, 'approved'.length);
    await screen.getByRole('button', { name: 'B' }).tap();
    await screen.getByRole('button', { name: 'Check document' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Document approved');
  });

  test('bold that spills into the previous word fails the check', async ({ app, screen, web }) => {
    await app.open('/e/rich-text-editor');
    await typeAndSelectTail(screen, web, 'se approved'.length);
    await screen.getByRole('button', { name: 'B' }).tap();
    await screen.getByRole('button', { name: 'Check document' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Only the word approved must be bold');
  });
});
