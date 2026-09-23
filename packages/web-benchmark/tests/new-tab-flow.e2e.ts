import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { readCode } from './support.ts';

test('reads the code from the verification tab and enters it in the opener', async ({ app, screen, web }) => {
  await app.open('/e/new-tab-flow');

  const popup = await web.waitForPopup(() =>
    screen.getByRole('button', { name: 'Open verification tab' }).tap(),
  );
  await expect(web).toHaveTitle('Verification');
  const code = await readCode(screen.getByText(/^TAB-\d+$/), /TAB-\d+/);
  await popup.close();

  await expect(web).toHaveURL('/e/new-tab-flow');
  await screen.getByPlaceholder('Verification code').fill(code);
  await screen.getByRole('button', { name: 'Verify' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Verified successfully');
});
