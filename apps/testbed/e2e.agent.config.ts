import type { E2EConfig } from 'e2e';
import { web } from '@e2edev/web';
import { gateway } from 'ai';

/**
 * Live trace view: `E2E_DEVTOOLS=1` registers the AI SDK devtools recorder,
 * which streams every model call into `.devtools/generations.json` and pings
 * a running `npx unbox-ai devtools` (or `npx @ai-sdk/devtools`) viewer. The
 * config loads in every worker, so each worker's calls are captured; that
 * recorder keeps one database per process and rewrites it whole, so keep
 * `workers: 1` while it is on. For a file to inspect after the run, prefer
 * `e2e run --ai-trace`, which needs no setup.
 */
if (process.env.E2E_DEVTOOLS !== undefined && process.env.E2E_DEVTOOLS !== '') {
  const { registerTelemetry } = await import('ai');
  const { DevToolsTelemetry } = await import('@ai-sdk/devtools');
  registerTelemetry(DevToolsTelemetry());
}

/**
 * Opt-in agentic suite against the local playground. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:agent
 *
 * Not part of CI: every test spends real model calls, and act flows and
 * judgments are structurally comparable across models, not identical.
 * `E2E_MODEL` overrides the pinned model so one suite dogfoods several
 * providers.
 */
export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web({
        url: 'http://127.0.0.1:4272',
        command: { executable: 'node', args: ['app/server.mjs'], env: { PORT: '4272' } },
      }),
    },
  ],
  // Every agent step includes model round trips; a loaded provider needs
  // room. Latency is not a product defect: give the test and the judgment
  // tier time rather than reading timeouts as failures.
  timeout: 300_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
      timeout: 90_000,
      // The drawn keypad flow is one step of a dozen taps, each a model turn.
      maxSteps: 40,
      maxModelCalls: 60,
      context: [
        'This is the e2e playground app: a small multi-page site with todos,',
        'forms, a sign-in flow, a workspace wizard, and release notes.',
        'Prefer the control whose accessible name matches the request exactly.',
      ].join(' '),
    },
  },
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
} satisfies E2EConfig;
