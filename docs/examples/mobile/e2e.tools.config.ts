import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';

const iphone = agentDevice({ platform: 'ios', app: 'Settings' });
const pixel = agentDevice({ platform: 'android', app: 'com.android.settings' });

export default {
  // Every device engine the config declares goes into the one pack.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
    tools: agentDeviceTools(iphone, pixel),
  }),
  targets: [
    { name: 'iphone', platform: 'ios', engine: iphone },
    { name: 'pixel', platform: 'android', engine: pixel },
  ],
  workers: 1,
} satisfies E2EConfig;
