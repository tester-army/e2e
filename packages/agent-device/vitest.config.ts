import { defineConfig } from 'vitest/config';

/**
 * Every suite here runs against the in-memory daemon in `tests/helpers`, so
 * nothing owns a simulator and nothing needs a worker cap. Coverage that needs
 * a real device lives in the testbed's opt-in mobile suites instead.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    include: ['tests/unit/**/*.test.ts'],
  },
});
