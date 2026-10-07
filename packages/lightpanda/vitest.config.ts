import { defineConfig } from 'vitest/config';

/** Unit tests: the Lightpanda binary is a fake node script, no download. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
