import { defineConfig } from 'vitest/config';

/**
 * Telemetry stays off for every test and every CLI the tests spawn, which
 * inherit the environment. The telemetry suite opts back in per instance.
 */
const env = { E2E_TELEMETRY_DISABLED: '1' };

/**
 * Unit tests are pure and run fully in parallel. Integration tests own real
 * browsers, app processes, and worker processes, so their concurrency is
 * bounded: oversubscribing CPUs starves them into timeouts that are
 * indistinguishable from product failures.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    env,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          env,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          env,
          // Bounded rather than serial: these files own real browsers, app
          // processes, and worker processes, and starving them of CPU produces
          // timeouts indistinguishable from product failures. Vitest 4 requires
          // projects with different maxWorkers to run in separate groups.
          maxWorkers: 3,
          minWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
