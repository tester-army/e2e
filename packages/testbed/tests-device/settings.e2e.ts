/**
 * Agentic flows through the iOS Settings app. The backend opens Settings
 * fresh before each test; every step below stays inside the grammar verbs
 * (tap, type, scroll), so a passing run records a trace and the next run
 * replays it with zero model calls. Judgments are never cached.
 */

import { expect, test } from './fixtures.ts';

test('reads the software version under a dark, offline arrangement', async ({ agent, device, screen }) => {
  // Deterministic backend-defined arrangements: no model, recorded as device.* steps.
  await device.setAppearance('dark');
  await device.setNetwork('offline');
  await device.setLocation({ latitude: 37.3349, longitude: -122.009 });

  await agent.act('go to General, then open About');
  await agent.assert('the About screen shows an iOS Version row with a version number');
  await expect(screen.getByRole('button', { name: /^iOS Version, \d/ })).toBeVisible();

  await device.setNetwork('online');
});

test('navigates to Calendar under a light arrangement', async ({ agent, device, screen }) => {
  await device.setAppearance('light');

  await agent.act('navigate to Apps, then Calendar, without using search');
  await agent.assert('a Calendar settings screen is visible');
  await expect(device.locator('role=NavigationBar id=Calendar')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Apps' })).toBeVisible();
});

test('toggles a Keyboard switch through the agent and restores it deterministically', async ({ agent, device, screen }) => {
  await agent.act('go to General, then Keyboard');
  await expect(device.locator('role=NavigationBar id=Keyboards')).toBeVisible();

  const haptic = screen.getByRole('switch', { name: 'Haptic Feedback' });
  await haptic.uncheck();
  await expect(haptic).not.toBeChecked();

  await agent.act('turn Haptic Feedback on');
  await expect(haptic).toBeChecked();

  await haptic.uncheck();
  await expect(haptic).not.toBeChecked();
});
