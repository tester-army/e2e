import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { loadAgent } from './fixtures/agent-module.ts';

/**
 * Hand-off stress: the long-flow bench app with a deliberately small ledger
 * budget. A real fifty-step flow overruns the default 8 KiB ledger; a 2 KiB
 * budget reproduces that overrun in twenty steps, so the question "does a fact
 * from step 2 reach step 20?" is answered in a minute rather than an hour.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:handoff -- --ai-trace
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'testbed-bench-handoff',
  app: {
    url: 'http://localhost:4273',
    command: {
      executable: 'pnpm',
      args: ['run', 'bench:serve'],
    },
  },
  tests: 'tests-bench-long/handoff.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  timeout: 900_000,
  actionTimeout: 90_000,
  workers: 1,
  limits: { maxLedgerBytes: 2_048 },
  agent: {
    executor: await loadAgent(),
    model: process.env.E2E_MODEL ?? 'google/gemini-3.8-flash',
    maxSteps: 40,
    maxModelCalls: 40,
  },
  cache: 'off',
});
