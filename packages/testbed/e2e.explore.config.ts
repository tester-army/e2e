import type { E2EConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

/**
 * `e2e explore` against the bug garden (`app/bug-garden.mjs`), a bookshop
 * with planted defects. Manual and opt-in: real model calls.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed explore:garden
 *
 * `E2E_MODEL` picks the model. `BENCH_PORT` picks the garden's port, so the
 * bench (`packages/bench`) can run several gardens at once; `BUG_GARDEN_CLEAN=1`
 * starts the garden with every defect fixed, the bench's false-positive
 * control. `EXPLORE_APP_URL` points at a garden already running instead.
 * `E2E_PROVIDER_OPTIONS` carries JSON provider options for an effort sweep.
 */
const url = process.env.EXPLORE_APP_URL;
const port = process.env.BENCH_PORT ?? '4275';
const clean = process.env.BUG_GARDEN_CLEAN === '1';
const providerOptions = process.env.E2E_PROVIDER_OPTIONS;

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-explore',
  tests: 'tests-explore/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: playwright(
        url === undefined
          ? {
              url: `http://127.0.0.1:${port}`,
              command: {
                executable: 'node',
                args: ['app/bug-garden.mjs'],
                env: { PORT: port, ...(clean ? { BUG_GARDEN_CLEAN: '1' } : {}) },
              },
            }
          : { url },
      ),
    },
  ],
  timeout: 900_000,
  actionTimeout: 60_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast'),
      ...(providerOptions === undefined || providerOptions === ''
        ? {}
        : { providerOptions: JSON.parse(providerOptions) as Record<string, Record<string, unknown>> }),
      context: 'Bookshelf is a small online bookshop: a catalog, a cart, checkout, an account page, an orders page, and sign-in.',
    },
  },
  credentials: {
    ada: { username: 'ada@example.test', password: 'bookworm' },
  },
} satisfies E2EConfig;
