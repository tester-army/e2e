import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

export default {
  // One model for every agent.* call, checked once when the first test acquires the agent fixture.
  // The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY.
  // Any AI SDK model works here: openai('gpt-5.4-mini') from @ai-sdk/openai calls the provider directly.
  agents: {
    default: createAgent({
      model: gateway('openai/gpt-5.4-mini'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    }),
  },
  // The engine declares the app it drives; APP_URL overrides the default at run time.
  targets: [{
    name: 'web',
    platform: 'web',
    engine: playwright({
      url: process.env.APP_URL ?? 'http://localhost:3000',
      // Let the runner start the dev server and wait for url to answer:
      // command: { executable: 'npm', args: ['run', 'dev'] },
    }),
  }],
} satisfies E2EConfig;
