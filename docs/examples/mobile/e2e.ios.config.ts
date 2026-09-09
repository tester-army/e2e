import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';

export default {
  // The model comes from E2E_MODEL; authenticate with E2E_MODEL_API_KEY.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
  }),
  // Requires Xcode and an iOS simulator. Replace Settings with your app's bundle ID.
  targets: [{ name: 'ios', platform: 'ios', engine: agentDevice({ platform: 'ios', app: 'Settings' }) }],
  workers: 1,
} satisfies E2EConfig;
