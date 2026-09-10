import { defineConfig } from 'vitest/config';

/** Pure unit tests: a fake fetch and a temp directory, no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
