import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('shadow DOM form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/shadow-dom-form');
  });

  // The input and the button live in a closed shadow root nested inside an
  // open one; plain queries reach them because the engine searches the
  // closed roots the page attached.
  test('rejects a wrong access code', async ({ screen }) => {
    await screen.getByPlaceholder('Access code').fill('SHADOW-41');
    await screen.getByRole('button', { name: 'Submit' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong access code');
  });

  test('grants access with the code from the hint inside the root', async ({ screen }) => {
    await expect(screen.getByText('Access code hint: SHADOW-42')).toBeVisible();
    await screen.getByPlaceholder('Access code').fill('SHADOW-42');
    await expect(screen.getByPlaceholder('Access code')).toHaveValue('SHADOW-42');
    await screen.getByRole('button', { name: 'Submit' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Access granted');
  });
});
