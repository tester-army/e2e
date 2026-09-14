/**
 * Bench: the canonical login flow. The password is a Secret — the model sees
 * only its name and purpose, the fill runs through the authorized secret tool.
 */

import { test } from '@e2edev/playwright';
import { expect, credentials } from 'e2e';

test('signs in with the member credential', async ({ web, agent, screen }) => {
  await web.goto('/login');
  await agent.act('sign in with the given credentials', {
    params: { username: 'member', password: credentials.user('member').password },
  });
  await expect(screen.getByText('Welcome, member')).toBeVisible();
});
