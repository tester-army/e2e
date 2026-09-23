import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { readCode } from './support.ts';

test.describe('shadow DOM form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/shadow-dom-form');
  });

  test('rejects a wrong access code', async ({ screen }) => {
    await screen.getByPlaceholder('Access code').fill('SHADOW-41');
    await screen.getByRole('button', { name: 'Submit' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong access code');
  });

  test('grants access with the code from the hint inside the root', async ({ screen }) => {
    const code = await readCode(screen.getByText(/Access code hint:/), /SHADOW-\d+/);
    await screen.getByPlaceholder('Access code').fill(code);
    await expect(screen.getByPlaceholder('Access code')).toHaveValue(code);
    await screen.getByRole('button', { name: 'Submit' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Access granted');
  });
});
