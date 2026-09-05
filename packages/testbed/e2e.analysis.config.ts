import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

/**
 * Opt-in suite of deliberately failing deterministic tests, for iterating on
 * post-failure analysis against real screens and a real model. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:analysis
 *
 * Every test here is expected to fail; what the run is for is the analysis
 * line under each failure and the `e2edev.analysis` extension in the report.
 * `E2E_ANALYSIS_MODEL` overrides the pinned model.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-analysis',
  app: {
    url: 'http://127.0.0.1:4274',
    command: {
      executable: 'node',
      args: ['app/server.mjs'],
      env: { PORT: '4274' },
    },
  },
  tests: 'tests-analysis/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  // Failing assertions wait out their timeout; keep the run short.
  assertionTimeout: 2_000,
  actionTimeout: 5_000,
  analysis: {
    model: process.env.E2E_ANALYSIS_MODEL ?? 'google/gemini-3-flash',
    vision: process.env.E2E_ANALYSIS_VISION === '1',
  },
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
});
