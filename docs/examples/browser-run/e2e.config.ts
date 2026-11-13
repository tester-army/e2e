import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { browserRun } from '@e2e-dev/browser-run';

export default {
  targets: [{
    name: 'cloudflare',
    engine: web({ browser: browserRun() }),
    app: { url: 'https://staging.example.com' },
  }],
  workers: 2,
} satisfies E2EConfig;
