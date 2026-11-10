import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { e2b } from '@e2e-dev/e2b';

export default {
  targets: [
    {
      name: 'android',
      engine: mobile({ platform: 'android', device: e2b() }),
      app: { bundleId: 'com.example.app', appPath: 'build/app-debug.apk' },
    },
  ],
  workers: 4,
} satisfies E2EConfig;
