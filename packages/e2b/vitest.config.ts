import { defineConfig } from 'vitest/config';

/** Pure unit tests: the E2B SDK is a stub, no sandbox and no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
