import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { browserstack } from '@e2e-dev/browserstack';

const apk = 'https://www.browserstack.com/app-automate/sample-apps/android/WikipediaSample.apk';

export default {
  targets: [
    {
      name: 'pixel-7',
      engine: mobile({
        platform: 'android',
        device: browserstack({ device: 'Google Pixel 7', osVersion: '13.0', app: apk, appiumVersion: '3.2.0' }),
      }),
      app: { bundleId: 'org.wikipedia.alpha' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
