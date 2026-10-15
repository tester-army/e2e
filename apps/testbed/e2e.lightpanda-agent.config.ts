import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';
import { gateway } from 'ai';

/**
 * The agent suite on Lightpanda; the same tests as `e2e.agent.config.ts`,
 * run manually with a model key:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:lightpanda:agent
 *
 * The failures to expect are the drawn, dragged, and below-the-fold flows
 * the Lightpanda integration page lists.
 */

export default {
  projectId: 'dev.e2e.testbed-agent-lightpanda',
  tests: 'tests-agent/**/*.e2e.ts',
  targets: [
    {
      name: 'lightpanda',
      engine: web({ browser: lightpanda({ loadResources: ['iframe'] }) }),
      app: {
        url: 'http://127.0.0.1:4273',
        command: { executable: 'node', args: ['app/server.mjs'], env: { PORT: '4273' } },
      },
    },
  ],
  timeout: 300_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
      judgmentTimeout: 90_000,
      maxSteps: 40,
      maxModelCalls: 60,
      context: [
        'This is the e2e playground app: a small multi-page site with todos,',
        'forms, a sign-in flow, a workspace wizard, and release notes.',
        'Prefer the control whose accessible name matches the request exactly.',
      ].join(' '),
    },
  },
  credentials: { admin: { username: 'admin', password: 'admin-pass' } },
} satisfies E2EConfig;
