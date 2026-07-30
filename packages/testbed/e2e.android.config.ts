import { defineConfig } from 'e2e';
import { agentDevice } from '@e2edev/agent-device';

/**
 * Android half of the mobile dogfood suite, against the built-in Settings app.
 *
 *   pnpm --filter @e2edev/testbed test:android
 *
 * Not part of CI: it needs an Android SDK and a booted emulator.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-android',
  tests: 'tests-android/**/*.e2e.ts',
  targets: [
    {
      name: 'android',
      platform: 'android',
      // Settings is a system app: its data container cannot be cleared, so each
      // attempt relaunches instead. A normal app keeps the default isolation.
      driver: agentDevice({ reset: 'relaunch' }),
      app: 'com.android.settings',
      device: process.env.E2E_ANDROID_DEVICE ?? 'Medium_Phone_API_36.1',
    },
  ],
  workers: 1,
  timeout: 180_000,
  actionTimeout: 60_000,
  assertionTimeout: 15_000,
  launchTimeout: 180_000,
  artifacts: ['screenshot'],
  reporters: ['list'],
});
