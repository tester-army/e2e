import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the backend through a scripted tmux runner and run fully
 * in parallel. Integration tests own a real tmux server on a private socket,
 * so they run serially and only when a developer opts in with
 * `E2E_TMUX_INTEGRATION=1`: CI has no tmux and a skipped suite must never read
 * as a passing one.
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
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
