import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { playwright } from '@e2edev/playwright';

export default {
  // The model comes from E2E_MODEL; authenticate with E2E_MODEL_API_KEY.
  // E2E_MODEL_ENDPOINT points at another OpenAI-compatible endpoint (default: the AI Gateway).
  // To call a provider directly, pass an AI SDK model: createAgent({ model: openai('gpt-5.4-mini') }).
  // That model is the one model for every agent.* call, checked once when the
  // first test acquires the agent fixture.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
  }),
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
