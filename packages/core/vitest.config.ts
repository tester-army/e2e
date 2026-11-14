import { defineConfig } from 'vitest/config';

/** e2e-core's own checks; the behavior runs under e2e's suites, which drive it through the runner too. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
