import { defineConfig } from 'vitest/config';

/** Pure unit tests: a stub xcodebuild on PATH, no Xcode and no simulator. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
