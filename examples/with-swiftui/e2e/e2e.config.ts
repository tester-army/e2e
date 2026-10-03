import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

export default {
  // The Vercel AI Gateway serves the model and reads AI_GATEWAY_API_KEY.
  // Only tests that use `agent` need it; tests/greeting.e2e.ts runs without one.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [
    {
      name: 'ios',
      engine: mobile({ platform: 'ios' }),
      // PRODUCT_BUNDLE_IDENTIFIER in the Xcode project. Build and install the app
      // first (`npm run build:ios && npm run install:ios`); the tests open
      // whatever is installed under this id.
      app: { bundleId: 'dev.e2e.examples.swiftui' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
