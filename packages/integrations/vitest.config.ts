import { defineConfig } from 'vitest/config';

/** Pure unit tests: each vendor SDK is mocked, no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
