import { defineConfig } from 'vitest/config';

/** Pure unit tests: Expo's API is a stubbed `fetch`, no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
