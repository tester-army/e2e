/** Compile-time assertions for the device engine's options and the hosted device provider seam. */
import type { DeviceLease, DeviceProvider, DeviceRequest, MobileOptions } from '../../src/index.ts';

({ platform: 'ios', app: 'Settings', device: 'iPhone 16' }) satisfies MobileOptions;
({ platform: 'android', app: 'com.android.settings', device: ['Pixel_8', 'Pixel_9'] }) satisfies MobileOptions;
({ platform: 'ios', settle: 200, transition: 500, snapshot: 'interactive' }) satisfies MobileOptions;
// `false` skips the settle wait, and a value read from the environment needs no conditional spread.
({ platform: 'ios', settle: false, device: process.env['E2E_DEVICE'] }) satisfies MobileOptions;
({
  platform: 'ios',
  app: 'com.example.app',
  launchArguments: ['-e2e', 'YES'],
  permissions: { camera: 'grant', notifications: 'deny', location: 'reset' },
}) satisfies MobileOptions;
({ platform: 'android', app: 'com.example.app', launchArguments: process.env['E2E_LAUNCH_ARGS']?.split(' ') }) satisfies MobileOptions;

const farm = {
  name: 'farm',
  acquire: async (request: DeviceRequest) => ({
    id: `${request.runId}-${request.slot}`,
    daemon: { baseUrl: 'http://10.0.0.7:4700', authToken: request.env['FARM_TOKEN'] },
    device: request.platform === 'ios' ? 'iPhone 16' : 'Pixel_8',
  }),
  release: async () => undefined,
} satisfies DeviceProvider;
({ platform: 'ios', device: farm }) satisfies MobileOptions;
({ id: 'lease-1', daemon: { baseUrl: 'http://10.0.0.7:4700' } }) satisfies DeviceLease;

// @ts-expect-error the platform is ios or android.
({ platform: 'web' }) satisfies MobileOptions;
// @ts-expect-error the snapshot mode is full or interactive.
({ platform: 'ios', snapshot: 'all' }) satisfies MobileOptions;
// @ts-expect-error settle is milliseconds or false; true names no window.
({ platform: 'ios', settle: true }) satisfies MobileOptions;
// @ts-expect-error the transition budget is a number of milliseconds.
({ platform: 'ios', transition: '500ms' }) satisfies MobileOptions;
// @ts-expect-error a permission is granted, denied, or reset; Maestro's `allow` is `grant`.
({ platform: 'ios', permissions: { camera: 'allow' } }) satisfies MobileOptions;
// @ts-expect-error only a permission agent-device names.
({ platform: 'ios', permissions: { bluetooth: 'grant' } }) satisfies MobileOptions;
// @ts-expect-error launch arguments are the strings the platform launch command takes.
({ platform: 'ios', launchArguments: [1] }) satisfies MobileOptions;
// @ts-expect-error a device is a name, a pool of names, or a provider; a lease is none of those.
({ platform: 'ios', device: { id: 'lease-1', daemon: { baseUrl: 'http://10.0.0.7:4700' } } }) satisfies MobileOptions;
// @ts-expect-error a provider releases what it leased.
({ name: 'farm', acquire: async () => ({ id: 'lease-1', daemon: { baseUrl: 'http://10.0.0.7:4700' } }) }) satisfies DeviceProvider;
// @ts-expect-error a lease carries the id the provider gets back on release.
({ daemon: { baseUrl: 'http://10.0.0.7:4700' } }) satisfies DeviceLease;
// @ts-expect-error a lease names its daemon by URL.
({ id: 'lease-1', daemon: { baseUrl: 4700 } }) satisfies DeviceLease;
