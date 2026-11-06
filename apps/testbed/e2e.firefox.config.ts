import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import config from './e2e.config.ts';

/** The deterministic suite on Firefox: CI runs it with `E2E_WEB_DRIVER=bidi`. */
export default {
  ...config,
  filters: [],
  targets: config.targets.map((target) => ({ ...target, engine: web({ browser: 'firefox' }) })),
} satisfies E2EConfig;
