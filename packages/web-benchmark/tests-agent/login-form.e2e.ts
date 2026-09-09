/**
 * `agent.act()` against a real model on the Login Form scenario. The password
 * is a Secret: the model sees only its name and purpose, and the fill runs
 * through the authorized secret tool. The deterministic check after the step
 * is what makes the test pass or fail; the model only drives.
 */

import { test } from '@e2edev/playwright';
import { expect, credentials } from '@e2edev/e2e';

test('act signs in with the benchmark account', async ({ app, agent, screen }) => {
  const account = credentials.user('benchmark');
  await app.open('/e/login-form');
  await agent.act('log in with the given credentials', {
    params: { email: account.username, password: account.password },
  });
  await expect(screen.getByTestId('success-message')).toHaveText('Logged in successfully');
});
