import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

// The applicationId in androidApp/build.gradle.kts and the bundle identifier in
// iosApp/iosApp.xcodeproj. Build and install the app first (see the README);
// the tests open whatever is installed under this id.
const app = { bundleId: 'dev.e2e.examples.kmp' };

export default {
  // The Vercel AI Gateway serves the model and reads AI_GATEWAY_API_KEY.
  // Only tests that use `agent` need it; tests/deterministic.e2e.ts runs without one.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  // Pick one with --target or the test:e2e:android and test:e2e:ios scripts.
  targets: [
    { name: 'android', engine: mobile({ platform: 'android' }), app },
    { name: 'ios', engine: mobile({ platform: 'ios' }), app },
  ],
  workers: 1,
} satisfies E2EConfig;
