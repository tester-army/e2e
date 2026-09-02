import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the backend through a scripted agent-device client and run
 * fully in parallel. Integration tests own one real simulator through the
 * agent-device daemon, so they run serially and only when a developer opts in
 * with `E2E_AGENT_DEVICE_SIMULATOR=1`: CI has no simulator and a skipped suite
 * must never read as a passing one.
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
