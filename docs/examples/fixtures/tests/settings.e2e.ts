import { expect, signedInTest as test } from './fixtures.ts';

test('shows the account email', async ({ app, screen, signedIn }) => {
  await app.open('/settings');
  await expect(screen.getByLabel('Email')).toHaveValue(signedIn.email);
});
