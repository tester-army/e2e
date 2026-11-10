import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';

export default {
  targets: [
    {
      name: 'ios',
      engine: mobile({ platform: 'ios', device: 'iPhone 17' }),
      app: {
        bundleId: 'com.example.app',
        appPath: 'ios/build/MyApp.app',
        launchArguments: ['-e2e', 'YES'],
        permissions: { notifications: 'grant' },
      },
    },
    {
      name: 'android',
      engine: mobile({ platform: 'android' }),
      app: {
        bundleId: 'com.example.app',
        appPath: 'android/app/build/outputs/apk/release/app-release.apk',
        launchArguments: ['--ez', 'e2e', 'true'],
        permissions: { notifications: 'grant' },
      },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
