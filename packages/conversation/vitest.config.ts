import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the backend through a scripted conversation client and run
 * fully in parallel. Integration tests own one real live agent through the
 * conversation daemon, so they run serially and only when a developer opts in
 * with `E2E_CONVERSATION_LIVE=1`: CI has no live agent and a skipped suite
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
