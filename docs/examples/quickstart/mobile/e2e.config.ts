import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { mobile } from '@e2edev/mobile';
import { gateway } from 'ai';

export default {
  agents: { default: createAgent({ model: gateway('openai/gpt-6-luna-fast') }) },
  targets: [{ name: 'ios', engine: mobile({ platform: 'ios', app: 'Settings' }) }],
  workers: 1,
} satisfies E2EConfig;
