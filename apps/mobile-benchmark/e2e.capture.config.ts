import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

/**
 * Hand-run capture of raw device snapshots for the mobile engine's golden
 * fixtures (`tests-capture/snapshots.e2e.ts`). One worker, so each platform
 * drives exactly the `-0` session the capture reads from.
 */
export default {
  ...base,
  projectId: 'dev.e2e.mobile-benchmark-capture',
  tests: 'tests-capture/**/*.e2e.ts',
  workers: 1,
  retries: 0,
  reporters: ['list'],
} satisfies E2EConfig;
