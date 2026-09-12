import { execSync } from 'node:child_process';
import type { E2EConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

/**
 * Post-run failure analysis against the bug garden (`app/bug-garden.mjs`), a
 * bookshop with ten planted bugs. Every test in tests-analysis fails on
 * purpose, each with the classification its title predicts; the run is what
 * the analysis should say about them.
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/e2e/dist/cli/bin.js run --config e2e.analysis.config.ts
 */
const model = gateway(process.env['E2E_ANALYSIS_MODEL'] ?? 'openai/gpt-5.6-luna-fast');

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed.analysis',
  tests: 'tests-analysis/**/*.e2e.ts',
  targets: [
    {
      name: 'shop',
      engine: playwright({
        url: 'http://127.0.0.1:4275',
        command: { executable: 'node', args: ['app/bug-garden.mjs'], env: { PORT: '4275' } },
      }),
    },
  ],
  assertionTimeout: 1_500,
  actionTimeout: 2_000,
  agents: { default: { model } },
  analysis: {
    model,
    vision: process.env['E2E_ANALYSIS_VISION'] === '1',
    instructions: 'Bookshelf is a plain HTML bookshop with no test ids; controls are addressed by role and name.',
    evidence: [
      {
        name: 'git diff',
        async collect() {
          try {
            return execSync('git diff --stat HEAD -- app', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          } catch {
            return undefined;
          }
        },
      },
    ],
  },
} satisfies E2EConfig;
