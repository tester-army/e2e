import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

// The bundle id and package name from app.json. Build and install the app
// first (`npm run ios:release` or `npm run android:release`); the tests open
// whatever is installed under this id.
const app = { bundleId: 'dev.e2e.examples.expo' };

export default {
  // The Vercel AI Gateway serves the model and reads AI_GATEWAY_API_KEY.
  // Only tests that use `agent` need it; tests/greeting.e2e.ts runs without one.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  // Pick one with --target or the test:e2e:ios, test:e2e:android, and test:e2e:web scripts.
  targets: [
    { name: 'ios', engine: mobile({ platform: 'ios' }), app },
    { name: 'android', engine: mobile({ platform: 'android' }), app },
    {
      name: 'web',
      engine: web(),
      app: {
        url: 'http://localhost:8081',
        command: { executable: 'npm', args: ['run', 'web'], reuseExisting: true },
      },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
