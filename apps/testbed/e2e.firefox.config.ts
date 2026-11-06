import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import config from './e2e.config.ts';

/** The deterministic suite on Firefox. */
export default {
  ...config,
  filters: [],
  targets: config.targets.map((target) => ({ ...target, engine: web({ browser: 'firefox' }) })),
} satisfies E2EConfig;
