/**
 * The `device` methods no scenario flow needs, each with something the app
 * shows or the fixture reads back: the Control Inventory screen prints the
 * color scheme and the orientation, the home list is where a relaunch lands,
 * `foregroundApp` says which app is in front, and three plain screens print
 * the network state, the position, and the biometric enrollment.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, openScenario, test } from './fixtures.ts';

const APP_ID = 'dev.e2e.benchmark';

test.describe('device fixture', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Control Inventory');
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

  // Android 14 and later ship no shell command for the clipboard service, so
  // agent-device 0.21.13 reads an empty string back on the emulator; its own
  // advice is to paste into a field and read that.
  test('the clipboard reads back what was written', { platforms: ['ios'] }, async ({ device }) => {
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

  // agent-device 0.21.13's iOS appstate answers from the session (source:
  // session, surface: app) and refuses a device selector without one, so on
  // iOS home() leaves foregroundApp() naming the pinned app; Android reads
  // the device's foreground activity.
  test('foregroundApp sees the home screen after home()', { platforms: ['android'] }, async ({ device }) => {
    await device.home();
    expect((await device.foregroundApp()).bundleId).not.toBe(APP_ID);
  });

  // The close names the app, so agent-device terminates it before ending the
  // session; a bare close would leave it running and openApp would resume it here.
  test('closeApp then openApp relaunches on the home list', async ({ device, screen }) => {
    await device.closeApp();
    await device.openApp(APP_ID);
    expect((await device.foregroundApp()).bundleId).toBe(APP_ID);
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
    await expect(screen.getByTestId('Control Inventory')).toBeVisible();
    await expect(screen.getByTestId('inventory-header')).toBeHidden();
  });
});

test.describe('network status', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Network Status');
  });

  // The emulator has a cellular radio behind its Wi-Fi, so turning Wi-Fi off
  // moves the connection over rather than cutting it; airplane mode cuts it.
  test('setNetwork and setAirplaneMode change what the app sees', { platforms: ['android'] }, async ({ device, screen }) => {
    const type = screen.getByTestId('network-type');
    const connected = screen.getByTestId('network-connected');
    await expect(type).toHaveText('type: wifi');
    await expect(connected).toHaveText('connected: yes');
    try {
      await device.setNetwork('offline');
      await expect(type).toHaveText('type: cellular');
      await expect(connected).toHaveText('connected: yes');
      await device.setAirplaneMode(true);
      await expect(type).toHaveText('type: none');
      await expect(connected).toHaveText('connected: no');
    } finally {
      await device.setAirplaneMode(false);
      await device.setNetwork('online');
    }
    // The emulator's Wi-Fi takes a while to associate again after airplane mode.
    await expect(type).toHaveText('type: wifi', { timeout: 60_000 });
    await expect(connected).toHaveText('connected: yes');
  });

  test(
    'setNetwork and setAirplaneMode reach the app on the simulator',
    {
      platforms: ['ios'],
      skip: "agent-device 0.21.13's iOS wifi and airplane settings are simctl status_bar overrides: the status bar draws the change, the simulator stays online, and the app's network state never moves",
    },
    async ({ device }) => {
      await device.setNetwork('offline');
      await device.setAirplaneMode(true);
    },
  );
});

test.describe('location', () => {
  // The grant needs the app in the session, and a permission change
  // terminates the app on iOS, so the scenario is opened once for the grant
  // and once more, fresh, for the test.
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Location Reader');
    await device.setPermission('location', 'grant');
    await openScenario({ app, device, screen }, 'Location Reader');
  });

  test('setLocation moves the position the app reads', async ({ device, screen }) => {
    const coordinates = screen.getByTestId('location-coordinates');
    await device.setLocation({ latitude: 52.2297, longitude: 21.0122 });
    await screen.getByTestId('read-location').tap();
    await expect(coordinates).toHaveText('52.2297, 21.0122');
    await expect(screen.getByTestId('success-message')).toHaveText('Position read');

    await device.setLocation({ latitude: 48.8566, longitude: 2.3522 });
    await screen.getByTestId('read-location').tap();
    await expect(coordinates).toHaveText('48.8566, 2.3522');
  });

  // On iOS clearLocation revokes the app's location access (`simctl privacy
  // revoke`), which terminates the app like any permission change, so the
  // scenario is opened again.
  test('clearLocation revokes the position the app reads', { platforms: ['ios'] }, async ({ app, device, screen }) => {
    await device.clearLocation();
    await openScenario({ app, device, screen }, 'Location Reader');
    await screen.getByTestId('read-location').tap();
    await expect(screen.getByTestId('location-error')).toHaveText('Location permission denied');
    await expect(screen.getByTestId('location-coordinates')).toBeHidden();
  });

  // On Android clearLocation turns location services off for the whole
  // emulator (`location_mode 0`), and the fixture has no verb to turn them
  // back on, so the test restores them through adb; left off, every later
  // position read on this emulator would fail.
  test('clearLocation switches off the position the app reads', { platforms: ['android'] }, async ({ device, screen }) => {
    try {
      await device.clearLocation();
      await screen.getByTestId('read-location').tap();
      await expect(screen.getByTestId('location-error')).toHaveText('Location services are off');
      await expect(screen.getByTestId('location-coordinates')).toBeHidden();
    } finally {
      enableAndroidLocationServices();
    }
  });
});

test.describe('biometrics', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Biometric Lock');
  });

  // The prompt is a system sheet outside the app's tree, so the match is sent
  // blind once the app reports it is waiting on the prompt. Face ID is the
  // sensor of every current iPhone simulator, CI's iPhone 17 Pro included.
  const biometricGap = simctlBiometricGap();
  test(
    'enrollBiometrics and setBiometrics answer a biometric prompt',
    { platforms: ['ios'], ...(biometricGap === undefined ? {} : { skip: biometricGap }) },
    async ({ device, screen }) => {
      const enrolled = screen.getByTestId('biometric-enrolled');
      const unlock = screen.getByTestId('unlock-vault');
      await expect(screen.getByTestId('biometric-sensor')).toHaveText('sensor: face');
      try {
        await device.enrollBiometrics('faceid', false);
        await screen.getByTestId('refresh-biometrics').tap();
        await expect(enrolled).toHaveText('enrolled: no');
        await unlock.tap();
        await expect(screen.getByTestId('biometric-error')).toHaveText('error: not_enrolled');

        await device.enrollBiometrics('faceid', true);
        await screen.getByTestId('refresh-biometrics').tap();
        await expect(enrolled).toHaveText('enrolled: yes');
        await unlock.tap();
        await expect(unlock).toHaveText('Waiting…');
        await device.setBiometrics('faceid', 'match');
        await expect(screen.getByTestId('success-message')).toHaveText('Vault unlocked');
      } finally {
        await device.enrollBiometrics('faceid', false);
      }
    },
  );

  test(
    'setBiometrics answers a fingerprint prompt',
    {
      platforms: ['android'],
      skip: "enrollBiometrics takes faceid or touchid only: the emulator's fingerprint is enrolled by hand through Settings behind a screen lock, and the fixture has no verb for either",
    },
    async ({ device }) => {
      await device.setBiometrics('fingerprint', 'match');
    },
  );
});

/**
 * Turns the emulator's location services back on, the counterpart to
 * `clearLocation` that the device fixture does not declare. Finds adb where
 * the Android SDK is, or on the PATH as CI's emulator runner leaves it.
 */
function enableAndroidLocationServices(): void {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const adb = sdk === undefined ? 'adb' : resolve(sdk, 'platform-tools', 'adb');
  execFileSync(adb, ['shell', 'settings', 'put', 'secure', 'location_mode', '3'], { stdio: 'ignore' });
}

/**
 * Why the device fixture cannot drive the simulator's Face ID on this Mac, or
 * undefined when it can: agent-device 0.21.13 goes through `simctl biometric`,
 * a subcommand the installed Xcode's simctl has to declare. The probe runs on
 * a Mac only; elsewhere the iOS test is not collected.
 */
function simctlBiometricGap(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const help = execFileSync('xcrun', ['simctl', 'help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (/^\s*biometric\b/m.test(help)) return undefined;
  } catch {
    return 'xcrun simctl is not answering, so the Face ID prompt cannot be driven';
  }
  return "agent-device 0.21.13 drives the simulator's Face ID through `simctl biometric`, a subcommand this Xcode's simctl does not have (Xcode 27.0 included); the simulator still takes notifyutil on com.apple.BiometricKit, which the fixture does not send";
}
