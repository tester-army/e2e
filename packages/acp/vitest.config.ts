import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 3,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { E2E_TELEMETRY_DISABLED: '1' },
  },
});
