import { defineConfig } from 'vitest/config';

/** Pure unit tests: adb is a script that answers from a fixture, no device. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
