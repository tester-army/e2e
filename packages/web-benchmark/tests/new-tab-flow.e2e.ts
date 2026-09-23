import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('reads the code from the verification tab and enters it in the opener', async ({ app, screen, web }) => {
  await app.open('/e/new-tab-flow');

  const popup = await web.waitForPopup(() =>
    screen.getByRole('button', { name: 'Open verification tab' }).tap(),
  );
  await expect(web).toHaveTitle('Verification');
  const code = await screen.getByText(/^TAB-\d+$/).textContent();
  expect(code).toMatch(/^TAB-\d+$/);
  await popup.close();

  await expect(web).toHaveURL('/e/new-tab-flow');
  await screen.getByPlaceholder('Verification code').fill(code!);
  await screen.getByRole('button', { name: 'Verify' }).tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Verified successfully');
});
