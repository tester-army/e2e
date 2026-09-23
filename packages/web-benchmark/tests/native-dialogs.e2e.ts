import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('native dialogs', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/native-dialogs');
  });

  test('answers the confirm, prompt, and alert chain', async ({ screen, web }) => {
    const seen: string[] = [];
    const dispose = await web.onDialog(async (dialog) => {
      seen.push(dialog.message);
      if (dialog.message === 'Enter your gift code') {
        await dialog.accept('GIFT-7');
        return;
      }
      await dialog.accept();
    });
    await screen.getByRole('button', { name: 'Place order' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Order placed with code GIFT-7');
    expect(seen).toEqual(['Place this order?', 'Enter your gift code', 'Order placed. Thank you!']);
    await dispose();
  });

  test('dismissing the confirm cancels the order', async ({ screen, web }) => {
    const dispose = await web.onDialog('dismiss');
    await screen.getByRole('button', { name: 'Place order' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Order was cancelled');
    await dispose();
  });

  test('a wrong gift code is rejected', async ({ screen, web }) => {
    const dispose = await web.onDialog(async (dialog) => {
      await dialog.accept(dialog.message === 'Enter your gift code' ? 'GIFT-9' : undefined);
    });
    await screen.getByRole('button', { name: 'Place order' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Invalid gift code');
    await dispose();
  });
});
