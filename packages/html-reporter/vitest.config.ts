import { defineConfig } from 'vitest/config';

/** Pure unit tests: a temp directory and the built page template. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
