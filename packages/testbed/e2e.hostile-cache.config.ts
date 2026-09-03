import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { loadAgent } from './fixtures/agent-module.ts';

/**
 * Long-flow bench: many dependent `agent.act` steps on fat screens, plus one
 * step that has to carry state across a six-page wizard. Exists to measure
 * context management and step hand-off, so it runs with the trace cache OFF
 * — every step is a live model flow. Serves the PREBUILT app; run
 * `pnpm run bench:build` first.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:long -- --ai-trace
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'testbed-bench-hostile-cache',
  app: {
    url: 'http://localhost:4273',
    command: {
      executable: 'pnpm',
      args: ['run', 'bench:serve'],
    },
  },
  tests: 'tests-bench-long/hostile.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  // Sixteen live model steps per test: the budget is sized for a provider
  // answering in tens of seconds per call, since latency is not a defect.
  timeout: 900_000,
  actionTimeout: 90_000,
  workers: 1,
  agent: {
    executor: await loadAgent(),
    model: process.env.E2E_MODEL ?? 'google/gemini-3-flash',
    maxSteps: 40,
    maxModelCalls: 40,
  },
  cache: 'read-write',
});
