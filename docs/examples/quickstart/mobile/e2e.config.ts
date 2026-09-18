import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { gateway } from 'ai';

export default {
  agents: { default: createAgent({ model: gateway('openai/gpt-5.6-luna') }) },
  targets: [{ name: 'ios', engine: agentDevice({ platform: 'ios', app: 'Settings' }) }],
  workers: 1,
} satisfies E2EConfig;
