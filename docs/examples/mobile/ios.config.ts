import type { E2EConfig } from 'e2e';
import { ios } from '@e2e-dev/ios';

export default {
  targets: [
    {
      name: 'ios',
      engine: ios(),
      app: { bundleId: 'com.example.app', appPath: './build/MyApp.app' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
