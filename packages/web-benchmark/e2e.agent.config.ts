import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';
import { gateway } from 'ai';

/**
 * Agentic suite against the same app and account as the deterministic one.
 * It gates every PR alongside that suite (`spec.yml` passes the model key);
 * each step spends real model calls, cents per run. By hand:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/web-benchmark test:agent
 *
 * `E2E_MODEL` overrides the pinned model so one suite dogfoods several
 * providers.
 */
export default {
  ...base,
  projectId: 'dev.e2e.web-benchmark-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  // Every agent step includes model round trips, so the deterministic action
  // budget is too tight for a loaded provider. Latency is not a scenario defect.
  timeout: 300_000,
  actionTimeout: 90_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast'),
      // The ceiling a step may ask for: a per-call `maxSteps` can only lower it,
      // and the scroll-heavy scenarios declare the budget they need per test.
      maxSteps: 60,
      context: [
        'This is the e2e web benchmark: a list of self-contained scenarios, each',
        'served at /e/<slug>. A step plays out inside the scenario page it starts',
        'on; the "Benchmark Examples" link in the header leaves it, so never',
        'follow it unless the step says so.',
      ].join(' '),
    },
  },
} satisfies E2EConfig;
