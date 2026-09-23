import type { E2EConfig } from 'e2e';
import { mobile } from '@e2edev/mobile';

/**
 * Deterministic suite against the benchmark app on an iOS simulator and an
 * Android emulator. Every attempt opens the app fresh on its home list, so
 * each test taps into its own scenario first. The app must already be on the
 * device (`pnpm ios` / `pnpm android` build and install it), or point
 * `E2E_MOBILE_BENCHMARK_IOS_APP` / `E2E_MOBILE_BENCHMARK_ANDROID_APP` at a
 * simulator `.app` or an `.apk` and the engine installs it once per worker.
 * CI does exactly that in `.github/workflows/mobile.yml`, one target per job,
 * and pins the iOS target to the simulator it booted through
 * `E2E_MOBILE_BENCHMARK_IOS_DEVICE`.
 */
const APP_ID = 'dev.e2e.benchmark';

/**
 * The simulators the iOS target drives: the UDIDs in
 * `E2E_MOBILE_BENCHMARK_IOS_DEVICE`, comma-separated, one worker each; unset,
 * every booted simulator. CI boots two and lists both.
 */
const iosDevices = process.env.E2E_MOBILE_BENCHMARK_IOS_DEVICE?.split(',')
  .map((udid) => udid.trim())
  .filter((udid) => udid !== '');

export const ios = mobile({
  platform: 'ios',
  app: APP_ID,
  appPath: process.env.E2E_MOBILE_BENCHMARK_IOS_APP,
  device: iosDevices === undefined || iosDevices.length !== 1 ? iosDevices : iosDevices[0],
  identity: `${APP_ID}-ios`,
  session: 'e2e-mobile-benchmark-ios',
  // A control that just moved waits this long to come to rest before a tap;
  // an unmoved one is tapped at once, so the budget costs only after a
  // scroll. iOS reports a row's final frame from the first frame of a fling,
  // and the default half second let a tap after scrollUntilVisible land on
  // the row still passing underneath on a loaded simulator.
  transition: 1_500,
});

export const android = mobile({
  platform: 'android',
  app: APP_ID,
  appPath: process.env.E2E_MOBILE_BENCHMARK_ANDROID_APP,
  identity: `${APP_ID}-android`,
  session: 'e2e-mobile-benchmark-android',
});

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.mobile-benchmark',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    { name: 'ios-simulator', engine: ios },
    { name: 'android-emulator', engine: android },
  ],
  // One worker per simulator in the pool; an engine with fewer devices
  // narrows its own target. Each worker slot drives its own session.
  workers: Math.max(1, iosDevices?.length ?? 1),
  credentials: {
    // The Login Form and Flattened Login scenarios' hardcoded account; the
    // Login Form screen prints it as a hint.
    benchmark: {
      username: 'tester@tester.army',
      password: 'benchmark123',
    },
  },
} satisfies E2EConfig;
