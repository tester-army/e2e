import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { e2bBrowsers } from '@e2e-dev/e2b/web';

export default {
  targets: [
    {
      name: 'e2b-web',
      engine: web({ browser: e2bBrowsers() }),
      app: { url: 'https://staging.example.com' },
    },
  ],
  workers: 4,
} satisfies E2EConfig;
