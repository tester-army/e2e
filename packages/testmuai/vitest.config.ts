import { defineConfig } from 'vitest/config';

/** Pure unit tests: the provider only builds a URL, so nothing touches the network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
