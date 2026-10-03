import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { testmu } from '@e2e-dev/testmu';

const apk = 'https://prod-mobile-artefacts.lambdatest.com/assets/docs/proverbial_android.apk';
const ipa = 'https://prod-mobile-artefacts.lambdatest.com/assets/docs/proverbial_ios.ipa';

export default {
  targets: [
    {
      name: 'android-emulator',
      engine: mobile({
        platform: 'android',
        device: testmu({ device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: apk }),
      }),
      app: { bundleId: 'com.lambdatest.proverbial' },
    },
    {
      name: 'ios-real',
      engine: mobile({
        platform: 'ios',
        device: testmu({ device: 'iPhone 16', osVersion: '18', app: ipa, deviceType: 'real' }),
      }),
      app: { bundleId: 'proverbial' },
    },
    {
      name: 'android-real',
      engine: mobile({
        platform: 'android',
        device: testmu({ device: 'Pixel 6', osVersion: '14', app: apk, deviceType: 'real' }),
      }),
      app: { bundleId: 'com.lambdatest.proverbial' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
