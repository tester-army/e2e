import { defineConfig } from 'e2e';
import { agentDevice } from 'e2e/agent-device';

/**
 * Mobile dogfood suite. It drives the built-in iOS Settings app, so it needs no
 * app build of its own:
 *
 *   pnpm --filter @e2e/testbed test:mobile
 *
 * Not part of CI: it needs macOS, Xcode, and a booted simulator, and the first
 * run builds the XCTest runner agent-device uses for snapshots.
 *
 * A mobile target has no app URL, which is why this config declares no `app`.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-mobile',
  tests: 'tests-mobile/**/*.e2e.ts',
  targets: [
    {
      name: 'ios',
      platform: 'ios',
      // Settings is a built-in system app with no data container, so it cannot
      // be state-cleared between attempts. Relaunching is the honest opt-out;
      // a normal app should keep the default `clear-state` isolation.
      driver: agentDevice({ reset: 'relaunch' }),
      // A bundle identifier of an already-installed app. A path to a .app,
      // .ipa, .apk, or .aab would be installed instead.
      app: 'com.apple.Preferences',
      device: process.env.E2E_IOS_DEVICE ?? 'iPhone 17',
    },
  ],
  // Parallelism is one device per worker. This suite pins a single simulator,
  // so a second worker would only contend for it and be rejected. Real mobile
  // parallelism needs one configured device per worker.
  workers: 1,
  // Snapshots go through XCTest, which is an order of magnitude slower than a
  // browser query. Give actions room rather than reading device latency as a
  // product failure.
  timeout: 180_000,
  actionTimeout: 60_000,
  assertionTimeout: 15_000,
  launchTimeout: 180_000,
  // mobile-0.1 defines screenshot and video; it has no trace.
  artifacts: ['screenshot'],
  reporters: ['list'],
});
