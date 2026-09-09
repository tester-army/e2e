import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('one submit opens one confirm, even when double-clicked', async ({ app, screen, web }) => {
  await app.open('/e/deferred-dialog');
  let dialogs = 0;
  const dispose = await web.onDialog(async (dialog) => {
    dialogs += 1;
    await dialog.accept();
  });
  await screen.getByRole('button', { name: 'Submit report' }).doubleTap();
  await expect(screen.getByTestId('success-message')).toHaveText(
    'Report submitted after deferred confirmation',
  );
  expect(dialogs).toBe(1);
  await dispose();
});
