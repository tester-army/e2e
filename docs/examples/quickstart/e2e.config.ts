import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

export default {
  // The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY.
  agents: {
    default: createAgent({
      model: gateway('openai/gpt-5.6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    }),
  },
  targets: [{
    engine: playwright({
      url: process.env.APP_URL ?? 'http://localhost:3000',
      // Or let the runner start the dev server:
      // command: { executable: 'npm', args: ['run', 'dev'] },
    }),
  }],
} satisfies E2EConfig;
