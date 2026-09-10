import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

/**
 * `e2e explore` against the bug garden (`app/bug-garden.mjs`), a bookshop
 * with planted defects. Manual and opt-in: real model calls.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed explore:garden
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed explore:bench
 *
 * `EXPLORE_APP_URL` points the target at an already running garden (the bench
 * starts one per run); without it the config starts one on port 4275.
 * `E2E_MODEL` picks the model.
 */

const url = process.env.EXPLORE_APP_URL;
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
              url: 'http://127.0.0.1:4275',
              command: { executable: 'node', args: ['app/bug-garden.mjs'], env: { PORT: '4275' } },
            }
          : { url },
      ),
    },
  ],
  timeout: 900_000,
  actionTimeout: 60_000,
  agents: {
    default: {
      model: process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast',
      context: 'Bookshelf is a small online bookshop: a catalog, a cart, checkout, an account page, an orders page, and sign-in.',
    },
  },
  credentials: {
    ada: { username: 'ada@example.test', password: 'bookworm' },
  },
} satisfies E2EConfig;
