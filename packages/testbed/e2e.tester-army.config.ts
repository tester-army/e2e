import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

/**
 * Long-running agentic journey against the production tester.army site.
 * Opt-in and manual only — real model calls against a real deployment:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed run test:tester-army
 *
 * The journey is strictly read-only (the agent context below forbids sign-up,
 * form submission, and leaving the site). The trace cache is on by default,
 * so the second run replays the whole tour zero-turn; append `--no-cache` to
 * the CLI to force a fully live run.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'testbed-tester-army',
  app: {
    url: 'https://tester.army',
    environment: 'production',
    allowProduction: true,
    allowedOrigins: [
      'https://tester.army',
      'https://www.tester.army',
      'https://auth.tester.army',
    ],
  },
  tests: 'tests-tester-army/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  timeout: 600_000,
  actionTimeout: 90_000,
  agent: {
    model: process.env.E2E_MODEL ?? 'anthropic/claude-haiku-4.5',
    maxSteps: 40,
    maxModelCalls: 40,
    context: [
      'You are touring the production tester.army marketing site READ-ONLY.',
      'Never sign up, never submit any form, never type into inputs, and never',
      'follow links that leave tester.army (partner logos, social links).',
      'Navigate with the header menus and in-page links only.',
    ].join('\n'),
  },
});
