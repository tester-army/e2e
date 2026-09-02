/**
 * The contributed `device` fixture: deterministic device management recorded
 * as `device.<method>` steps. Each arrangement is checked through the
 * accessibility tree or the fixture itself, never through a model.
 */

import { expect, test } from './fixtures.ts';

test('reports the foreground app the backend opened', async ({ device }) => {
  const app = await device.foregroundApp();
  expect(app.name).toBe('Settings');
  expect(app.bundleId).toBe('com.apple.Preferences');
});

test('rotates the device and comes back to portrait', async ({ device, screen }) => {
  await device.setOrientation('landscape-left');
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
  await device.setOrientation('portrait');
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});

test('switches to another app and returns to Settings', async ({ device, screen }) => {
  await device.openApp('Reminders');
  expect((await device.foregroundApp()).name).toBe('Reminders');
  await device.openApp('Settings');
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});

test('round-trips the clipboard', async ({ device }) => {
  await device.setClipboard('e2e-device-suite');
  expect(await device.clipboard()).toBe('e2e-device-suite');
});
