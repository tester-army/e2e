import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { testmuBrowsers } from '@e2e-dev/testmu/web';

export default {
  targets: [
    {
      name: 'testmu-web',
      engine: web({ browser: testmuBrowsers(), viewport: null }),
      app: { url: 'https://staging.example.com' },
    },
  ],
} satisfies E2EConfig;
