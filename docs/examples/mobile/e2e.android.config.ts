import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';

export default {
  // The model comes from E2E_MODEL; authenticate with E2E_MODEL_API_KEY.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
  }),
  // Requires the Android SDK and an emulator. Replace com.android.settings with your app's package.
  targets: [{
    name: 'android',
    platform: 'android',
    engine: agentDevice({ platform: 'android', app: 'com.android.settings' }),
  }],
  workers: 1,
} satisfies E2EConfig;
