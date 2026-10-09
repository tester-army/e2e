import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { limrun } from '@e2e-dev/limrun';

export default {
  targets: [{
    name: 'ios',
    engine: mobile({ platform: 'ios', device: limrun() }),
    app: {
      bundleId: 'dev.e2e.examples.swiftui',
      appPath: 'build/HelloApp.app',
    },
  }],
  workers: 2,
} satisfies E2EConfig;
