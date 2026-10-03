import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the engine through a scripted agent-device client and run
 * fully in parallel. Real simulators and emulators are the mobile benchmark's,
 * which CI runs on both platforms.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
});
