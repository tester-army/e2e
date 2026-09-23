/**
 * The `device` methods no scenario flow needs, each with something the app
 * shows or the fixture reads back: the Control Inventory screen prints the
 * color scheme and the orientation, the home list is where a relaunch lands,
 * and `foregroundApp` says which app is in front.
 */

import { expect, openScenario, test } from './fixtures.ts';

const APP_ID = 'dev.e2e.benchmark';

test.describe('device fixture', () => {
  test.beforeEach(async ({ device, screen }) => {
    await openScenario({ device, screen }, 'Control Inventory');
  });

  // Only the iOS build follows the system appearance (`ios.userInterfaceStyle`
  // in app.json); the Android build stays light.
  test('setAppearance flips the color scheme the app reads', { platforms: ['ios'] }, async ({ device, screen }) => {
    const scheme = screen.getByTestId('color-scheme');
    await expect(scheme).toHaveText('scheme: light');
    try {
      await device.setAppearance('dark');
      await expect(scheme).toHaveText('scheme: dark');
    } finally {
      await device.setAppearance('light');
    }
    await expect(scheme).toHaveText('scheme: light');
  });

  test('setOrientation rotates the window the app measures', async ({ device, screen }) => {
    const orientation = screen.getByTestId('orientation');
    await expect(orientation).toHaveText('orientation: portrait');
    try {
      await device.setOrientation('landscape-left');
      await expect(orientation).toHaveText('orientation: landscape');
    } finally {
      await device.setOrientation('portrait');
    }
    await expect(orientation).toHaveText('orientation: portrait');
  });

  test('the clipboard reads back what was written', async ({ device }) => {
    await device.setClipboard('e2e clipboard 42');
    expect(await device.clipboard()).toBe('e2e clipboard 42');
  });

  test('home leaves the app, openApp brings it back where it was', async ({ device, screen }) => {
    expect((await device.foregroundApp()).bundleId).toBe(APP_ID);
    await device.home();
    await device.openApp(APP_ID);
    expect((await device.foregroundApp()).bundleId).toBe(APP_ID);
    await expect(screen.getByTestId('inventory-header')).toBeVisible();
  });

  test(
    'foregroundApp sees the home screen after home()',
    {
      skip: "agent-device's iOS appstate reports the session's app (source: session), never what is in front, so home() leaves foregroundApp() naming the pinned app",
    },
    async ({ device }) => {
      await device.home();
      expect((await device.foregroundApp()).bundleId).not.toBe(APP_ID);
    },
  );

  test('closeApp then openApp relaunches on the home list', async ({ device, screen }) => {
    await device.closeApp();
    await device.openApp(APP_ID);
    expect((await device.foregroundApp()).bundleId).toBe(APP_ID);
    await expect(screen.getByTestId('Benchmark Examples')).toBeVisible();
    await expect(screen.getByTestId('Login Form')).toBeVisible();
    await expect(screen.getByTestId('inventory-header')).toBeHidden();
  });

  // The reference promises APP_NOT_OPEN for a lost session.
  test('foregroundApp after closeApp reports the closed session as APP_NOT_OPEN', async ({ device }) => {
    await device.closeApp();
    const lost = await device.foregroundApp().then(
      () => undefined,
      (error: unknown) => error as { code?: string },
    );
    expect(lost?.code).toBe('APP_NOT_OPEN');
  });

  test('device.back pops the scenario', async ({ device, screen }) => {
    await device.back();
    await expect(screen.getByTestId('Benchmark Examples')).toBeVisible();
    await expect(screen.getByTestId('Control Inventory')).toBeVisible();
    await expect(screen.getByTestId('inventory-header')).toBeHidden();
  });

  test(
    'setNetwork and setAirplaneMode change what the app sees',
    { skip: 'the app has no network status surface; expo-network is not a dependency' },
    async ({ device }) => {
      await device.setNetwork('offline');
      await device.setAirplaneMode(true);
    },
  );

  test(
    'setLocation and clearLocation change what the app reads',
    { skip: 'the app has no location surface; expo-location is not a dependency' },
    async ({ device }) => {
      await device.setLocation({ latitude: 52.2297, longitude: 21.0122 });
      await device.clearLocation();
    },
  );

  test(
    'enrollBiometrics and setBiometrics answer a biometric prompt',
    { skip: 'the app has no biometric prompt; expo-local-authentication is not a dependency' },
    async ({ device }) => {
      await device.enrollBiometrics('faceid', true);
      await device.setBiometrics('faceid', 'match');
    },
  );
});
