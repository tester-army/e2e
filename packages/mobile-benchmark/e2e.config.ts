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

export const ios = mobile({
  platform: 'ios',
  app: APP_ID,
  appPath: process.env.E2E_MOBILE_BENCHMARK_IOS_APP,
  device: process.env.E2E_MOBILE_BENCHMARK_IOS_DEVICE,
  identity: `${APP_ID}-ios`,
  session: 'e2e-mobile-benchmark-ios',
  // iOS reports a row's final frame from the first frame of a scroll, so a
  // tap right after a swipe lands on whatever is still passing under that
  // frame. A drag on the home list flings it up to three screens and takes
  // over two seconds to come to rest on a loaded machine (a tap after 1.5 s
  // opened the scenario five rows above the one it was aimed at); the
  // default budget is half a second.
  transition: 3_000,
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
  // One device at a time: two workers would share the pinned sessions.
  workers: 1,
  credentials: {
    // The Login Form and Flattened Login scenarios' hardcoded account; the
    // Login Form screen prints it as a hint.
    benchmark: {
      username: 'tester@tester.army',
      password: 'benchmark123',
    },
  },
} satisfies E2EConfig;
