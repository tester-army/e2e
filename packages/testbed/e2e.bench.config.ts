import { defineConfig, type CacheMode } from 'e2e';
import { playwright } from '@e2edev/playwright';

const CACHE_MODES = ['off', 'read-only', 'read-write'] as const;

/** Validated `E2E_CACHE` override; a typo must fail loudly, not sail through. */
function cacheMode(): CacheMode {
  const raw = process.env.E2E_CACHE ?? 'read-write';
  if (!(CACHE_MODES as readonly string[]).includes(raw)) {
    throw new Error(`E2E_CACHE must be one of ${CACHE_MODES.join(', ')}, got "${raw}"`);
  }
  return raw as CacheMode;
}

/**
 * Bench suite: agentic flows against the deterministic Next.js app in
 * `bench/`. Serves the PREBUILT app — run `pnpm run bench:build` first.
 * Run manually:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:bench
 *
 * Like the other agentic suites this never gates a PR: every step spends
 * real model calls. `E2E_MODEL` overrides the pinned model.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'testbed-bench',
  app: {
    url: 'http://localhost:4273',
    command: {
      executable: 'pnpm',
      args: ['run', 'bench:serve'],
    },
  },
  tests: 'tests-bench/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  timeout: 300_000,
  actionTimeout: 90_000,
  agent: {
    model: process.env.E2E_MODEL ?? 'google/gemini-3-flash',
  },
  // The bench exists to exercise the trace cache: run once to record, again
  // to replay. `E2E_CACHE=off` benchmarks the uncached baseline.
  cache: cacheMode(),
  credentials: {
    member: {
      username: 'member',
      // A fill-time provider (vault lookup / TOTP shape): resolved on every
      // authorized fill — including replayed ones — never baked at load.
      password: () => Promise.resolve('bench-password-1'),
    },
  },
});
