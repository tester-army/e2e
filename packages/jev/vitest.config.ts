import { defineConfig } from 'vitest/config';

/** Pure unit tests over the screen parser and value resolution; no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
