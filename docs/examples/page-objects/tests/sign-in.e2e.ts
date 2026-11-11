import { expect } from 'e2e';
import { test } from './fixtures.ts';

test('rejects a wrong password', async ({ app, signInPage }) => {
  await app.open();
  await signInPage.signIn('ada@example.test', 'not-the-password');
  await expect(signInPage.error).toHaveText('Wrong email or password');
});
