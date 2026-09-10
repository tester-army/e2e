import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';
import base from './e2e.config.ts';

/**
 * The E2E Bench arm of this app: `packages/bench` runs the agentic suites
 * here once per model, repeat, and track, each run on its own app instance.
 * Everything that varies per run comes from the environment the bench sets:
 *
 * - `E2E_MODEL`: the gateway model id (required, no default: a bench run
 *   must name its arm).
 * - `BENCH_PORT`: the port this run's app listens on; the bench allocates
 *   one per run so runs can overlap.
 * - `E2E_PROVIDER_OPTIONS`: JSON provider options for an effort sweep.
 *
 * The cache is off and retries are zero: every model call is a measurement.
 * The scenarios run unchanged from `tests-agent/`; the judgment suite lives
 * in `tests-judgment/`. Pick either with the files argument:
 *
 *   BENCH_PORT=4401 E2E_MODEL=openai/gpt-5.6-luna \
 *     node node_modules/@e2edev/e2e/dist/cli/bin.js run tests-judgment --config e2e.bench.config.ts --no-cache
 */
const model = process.env.E2E_MODEL;
if (model === undefined || model === '') {
  throw new Error('e2e.bench.config.ts needs E2E_MODEL: the bench names the model per run');
}
const port = process.env.BENCH_PORT ?? '4280';
const providerOptions = process.env.E2E_PROVIDER_OPTIONS;

export default {
  ...base,
  projectId: 'dev.e2e.web-benchmark-bench',
  // Both suites are in scope; the files argument on the command line picks one.
  tests: ['tests-agent/**/*.e2e.ts', 'tests-judgment/**/*.e2e.ts'],
  targets: [
    {
      name: 'web',
      platform: 'web',
      engine: playwright({
        url: `http://127.0.0.1:${port}`,
        // The bench owns the port, so nothing else may answer on it: no reuse.
        command: { executable: 'pnpm', args: ['exec', 'next', 'start', 'app', '--port', port] },
      }),
    },
  ],
  timeout: 300_000,
  actionTimeout: 90_000,
  cache: 'off',
  retries: 0,
  agents: {
    default: {
      model: gateway(model),
      maxSteps: 60,
      ...(providerOptions === undefined || providerOptions === ''
        ? {}
        : { providerOptions: JSON.parse(providerOptions) as Record<string, Record<string, unknown>> }),
      context: [
        'This is the e2e web benchmark: a list of self-contained scenarios, each',
        'served at /e/<slug>. A step plays out inside the scenario page it starts',
        'on; the "Benchmark Examples" link in the header leaves it, so never',
        'follow it unless the step says so.',
      ].join(' '),
    },
  },
} satisfies E2EConfig;
