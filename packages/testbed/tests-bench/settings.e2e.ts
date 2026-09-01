/**
 * Bench: a revealed-target flow — the confirm button does not exist until a
 * prior action opens the panel, so replay must relocate against a screen the
 * step itself changed. Verified deterministically.
 */

import { test, expect } from 'e2e';

test('upgrades the plan through the confirm panel', async ({ web, agent, screen }) => {
  await web.goto('/settings');

  await agent.act('upgrade to the Pro plan, confirming when asked');
  await expect(screen.getByText('Plan: Pro')).toBeVisible();
});
