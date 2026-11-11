import { defineConfig } from 'vitest/config';

/** Pure unit tests: agent-device's client is a stub, no daemon and no network. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
