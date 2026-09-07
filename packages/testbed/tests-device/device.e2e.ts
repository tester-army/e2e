/**
 * The contributed `device` fixture and the portable `app` lifecycle, on both
 * platforms. Each arrangement is checked through the fixture itself or a
 * judgment, never through a platform label.
 */

import { expect, test } from './fixtures.ts';

const SETTINGS_APP = { ios: 'Settings', android: 'com.android.settings' } as const;
const SETTINGS_IDENTITY = /settings|com\.apple\.Preferences/i;

test('reports the Settings app the engine opened', async ({ device }) => {
  const app = await device.foregroundApp();
  expect(`${app.name} ${app.bundleId ?? ''}`).toMatch(SETTINGS_IDENTITY);
});

test('rotates the device and comes back to portrait', async ({ agent, device }) => {
  await device.setOrientation('landscape-left');
  await agent.assert('the Settings screen is shown');
  await device.setOrientation('portrait');
  await agent.assert('the Settings screen is shown');
});

test('leaves for the home screen and returns to Settings', async ({ agent, device, platform }) => {
  await device.home();
  await device.openApp(platform === 'android' ? SETTINGS_APP.android : SETTINGS_APP.ios);
  const app = await device.foregroundApp();
  expect(`${app.name} ${app.bundleId ?? ''}`).toMatch(SETTINGS_IDENTITY);
  await agent.assert('the Settings screen is shown');
});

test('restarts the app back to its home screen and takes a screenshot', async ({ agent, app }) => {
  await agent.act('open the Accessibility settings');
  await app.restart();
  await agent.assert('the Settings home screen is shown');
  const shot = await app.screenshot('home');
  expect(shot).toMatch(/^screenshots\/\d{3}-home\.png$/);
});
