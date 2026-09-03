/**
 * Bench: relocation stress. Every render rewrites ids and test ids and a
 * delayed section re-renders 1s after load, so only role + accessible name
 * survive; the acts must relocate by meaning, not by cached references.
 */

import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('activates named toggles despite churning ids', async ({ web, agent, screen }) => {
  await web.goto('/stale');
  await agent.act('turn on the "Activate plan" toggle');
  await expect(screen.getByText('Activate plan is on')).toBeVisible();

  await agent.act('turn on the "Enable notifications" toggle');
  await expect(screen.getByText('Enable notifications is on')).toBeVisible();
  await expect(screen.getByText('Start sync is off')).toBeVisible();
});
