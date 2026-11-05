import { defineConfig } from 'vitest/config';

/** Pure unit tests over report fixtures and a temp directory. */
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], testTimeout: 30_000, pool: 'forks' } });
