import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';
import agentConfig from './e2e.agent.config.ts';

/**
 * The agent suite on Lightpanda, run manually with a model key:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:lightpanda:agent
 *
 * The failures to expect are the drawn, dragged, and below-the-fold flows
 * the Lightpanda integration page lists.
 */
export default {
  ...agentConfig,
  projectId: 'dev.e2e.testbed-agent-lightpanda',
  targets: agentConfig.targets.map((target) => ({
    ...target,
    name: 'lightpanda',
    engine: web({ browser: lightpanda({ loadResources: ['iframe'] }) }),
    app: { ...target.app, url: 'http://127.0.0.1:4273', command: { ...target.app.command, env: { PORT: '4273' } } },
  })),
} satisfies E2EConfig;
