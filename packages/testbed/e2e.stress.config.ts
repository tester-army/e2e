import { defineConfig } from '@e2edev/e2e';
import base from './e2e.config.ts';

/** Reporter stress suite: failures, timeouts, skips, flakes, hostile titles. Never part of CI. */
export default defineConfig({
  ...base,
  projectId: 'dev.e2e.testbed-stress',
  tests: ['tests-stress/**/*.e2e.ts'],
});
