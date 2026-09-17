import { defineConfig } from 'vitest/config';

/** Unit tests: local HTTP servers stand in for the issuers and APIs, no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
