/**
 * Dogfood edge cases: steps expected to conclude blocked or failed. Run
 * manually and inspect the verdicts — the interesting output is the report,
 * not the exit code:
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/@e2edev/e2e/dist/cli/bin.js run --config e2e.dogfood-edge.config.ts
 */

import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-dogfood-edge',
  tests: 'tests-dogfood-edge/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: playwright({
        url: 'http://127.0.0.1:4311',
        command: { executable: 'node', args: ['dogfood/server.mjs'], env: { PORT: '4311' } },
      }),
    },
  ],
  timeout: 300_000,
  actionTimeout: 90_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast'),
    },
  },
} satisfies E2EConfig;
