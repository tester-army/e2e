import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the engine through a scripted Cua Driver client and run
 * fully in parallel. Integration tests own the real desktop through the
 * in-process driver, so they run serially and only when a developer opts in
 * with `E2E_CUA_DESKTOP=1`: CI has no granted Accessibility permission and a
 * skipped suite must never read as a passing one.
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
          testTimeout: 180_000,
          hookTimeout: 180_000,
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
