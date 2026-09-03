/**
 * Dogfood edge cases: steps expected to conclude blocked or failed. Run
 * manually and inspect the verdicts — the interesting output is the report,
 * not the exit code:
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/e2e/dist/cli/bin.js run --config e2e.dogfood-edge.config.ts
 */

import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { loadAgent } from './fixtures/agent-module.ts';

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-dogfood-edge',
  app: {
    url: 'http://127.0.0.1:4311',
    command: {
      executable: 'node',
      args: ['dogfood/server.mjs'],
      env: { PORT: '4311' },
    },
  },
  tests: 'tests-dogfood-edge/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  timeout: 300_000,
  actionTimeout: 90_000,
  agent: {
    executor: await loadAgent(),
    model: process.env.E2E_MODEL ?? 'google/gemini-3-flash',
  },
});
