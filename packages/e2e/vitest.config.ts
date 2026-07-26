import { defineConfig } from 'vitest/config';

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
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          // Bounded rather than serial: these files own real browsers, app
          // processes, and worker processes, and starving them of CPU produces
          // timeouts indistinguishable from product failures.
          poolOptions: { forks: { maxForks: 3, minForks: 1 } },
        },
      },
    ],
  },
});
