import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';
import base from './e2e.config.ts';

/**
 * The local suite on Lightpanda, run by hand to see which features its
 * nightly covers:
 *
 *   pnpm --filter @e2e-dev/testbed test:lightpanda
 */
export default {
  ...base,
  targets: base.targets.map((target) => ({ ...target, name: 'lightpanda', engine: web({ browser: lightpanda({ loadResources: ['iframe'] }) }) })),
} satisfies E2EConfig;
