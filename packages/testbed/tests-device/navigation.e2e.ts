/**
 * The deterministic tier on a device: `screen` queries resolve against the
 * accessibility tree, `expect` polls it, and `app.back()` walks the
 * navigation stack. No model is involved anywhere in this file.
 */

import { expect, test } from './fixtures.ts';

test('drills from Settings to About and back with locators only', async ({ app, screen, device }) => {
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

test('restarts the app back to its root screen', async ({ app, screen }) => {
  await screen.getByRole('button', { name: 'General' }).tap();
  await expect(screen.getByRole('button', { name: 'About' })).toBeVisible();
  await app.restart();
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
  const shot = await app.screenshot('root');
  expect(shot).toMatch(/^screenshots\/\d{3}-root\.png$/);
});

test('scrolls the root list until a lower row is on screen', async ({ screen }) => {
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Privacy & Security' }), { direction: 'down' });
  await expect(screen.getByRole('button', { name: 'Privacy & Security' })).toBeVisible();
});
