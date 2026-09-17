import type { E2EConfig } from 'e2e';
import agentic from './e2e.agent.config.ts';
import { gateway } from 'ai';
import { jevAgent } from '@e2edev/jev';

/**
 * The agentic suite with Jev as the step executor: the same scenarios, the
 * same account, a different brain. `E2E_FALLBACK` names the generative
 * model that writes values a step leaves open; the default agent's model is
 * kept so the two configs stay comparable.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/web-benchmark test:jev
 */
export default {
  ...agentic,
  projectId: 'dev.e2e.web-benchmark-jev',
  agents: {
    default: {
      ...agentic.agents.default,
      executor: jevAgent({
        fallback: gateway(process.env.E2E_FALLBACK ?? 'openai/gpt-5.6-luna-fast'),
        maxTurns: 40,
      }),
    },
  },
} satisfies E2EConfig;
