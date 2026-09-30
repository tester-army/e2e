import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('one submit opens one confirm, even when double-clicked', async ({ app, screen, browser }) => {
  await app.open('/e/deferred-dialog');
  let dialogs = 0;
  const dispose = await browser.onDialog(async (dialog) => {
    dialogs += 1;
    await dialog.accept();
  });
  await screen.getByRole('button', 'Submit report').doubleTap();
  await expect(screen.getByTestId('success-message')).toHaveText(
    'Report submitted after deferred confirmation',
  );
  expect(dialogs).toBe(1);
  await dispose();
});
