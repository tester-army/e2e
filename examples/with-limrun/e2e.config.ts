import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { limrun } from '@e2e-dev/limrun';

export default {
  projectId: 'dev.e2e.limrun-greeting',
  tests: 'tests/**/*.e2e.ts',
  workers: 1,
  targets: [{
    name: 'ios',
    engine: mobile({ platform: 'ios', device: limrun() }),
    app: {
      bundleId: 'dev.e2e.examples.swiftui',
      appPath: process.env.GREETING_IOS_APP ?? 'build/HelloApp.app',
    },
  }, {
    name: 'android',
    engine: mobile({ platform: 'android', device: limrun() }),
    app: {
      bundleId: 'dev.e2e.examples.compose',
      appPath: process.env.GREETING_ANDROID_APP ?? 'build/e2e-limrun-greeting.apk',
    },
  }],
} satisfies E2EConfig;
