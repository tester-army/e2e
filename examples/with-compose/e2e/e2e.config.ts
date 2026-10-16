import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

export default {
  // The Vercel AI Gateway serves the model and reads AI_GATEWAY_API_KEY.
  // Only tests that use `agent` need it; tests/deterministic.e2e.ts runs without one.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [
    {
      name: 'android',
      engine: mobile({ platform: 'android' }),
      // applicationId in app/build.gradle.kts. Build and install the app first
      // with `./gradlew installDebug`; the tests open the installed app.
      app: { bundleId: 'dev.e2e.examples.compose' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
