/**
 * iOS-only: the deterministic tier against the labels iOS Settings actually
 * exposes. Rows are `Button`s named after their label inside identified
 * `Cell`s; the navigation bar's identifier is the screen title. These are
 * platform facts, so the file is scoped with `platforms`.
 */

import { expect, test } from './fixtures.ts';

const IOS = { platforms: ['ios'] } as const;

test('drills from Settings to About and back with locators only', IOS, async ({ app, screen, device }) => {
  await screen.getByRole('button', { name: 'General' }).tap();
  await expect(device.locator('role=NavigationBar id=General')).toBeVisible();

  await screen.getByRole('button', { name: 'About' }).tap();
  await expect(device.locator('role=NavigationBar id=About')).toBeVisible();
  await expect(screen.getByRole('button', { name: /^Model Name, / })).toBeVisible();
  await expect(device.locator('role=StaticText label="iOS Version"')).toHaveText('iOS Version');

  await app.back();
  await expect(device.locator('role=NavigationBar id=General')).toBeVisible();
  await app.back();
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});

// Android emulators refuse shell clipboard writes (agent-device reports it as
// unsupported), so the round trip is an iOS fact until the emulator grows it.
test('round-trips the clipboard', IOS, async ({ device }) => {
  await device.setClipboard('e2e-device-suite');
  expect(await device.clipboard()).toBe('e2e-device-suite');
});

test('scrolls the root list until a lower row is on screen', IOS, async ({ screen }) => {
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Privacy & Security' }), { direction: 'down' });
  await expect(screen.getByRole('button', { name: 'Privacy & Security' })).toBeVisible();
});

test('navigates to Calendar under a light arrangement', IOS, async ({ agent, device, screen }) => {
  await device.setAppearance('light');
  await agent.act('navigate to Apps, then Calendar, without using search');
  await agent.assert('a Calendar settings screen is visible');
  await expect(device.locator('role=NavigationBar id=Calendar')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Apps' })).toBeVisible();
});

test('toggles a Keyboard switch through the agent and restores it deterministically', IOS, async ({ agent, device, screen }) => {
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
