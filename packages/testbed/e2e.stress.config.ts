import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

/** Reporter stress suite: failures, timeouts, skips, flakes, hostile titles. Never part of CI. */
export default {
  ...base,
  projectId: 'dev.e2e.testbed-stress',
  tests: ['tests-stress/**/*.e2e.ts'],
} satisfies E2EConfig;
