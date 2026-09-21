import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { web } from '@e2edev/web';
import { gateway } from 'ai';

export default {
  agents: { default: createAgent({ model: gateway('openai/gpt-5.6-luna') }) },
  targets: [{ engine: web({ url: 'http://localhost:3000' }) }],
} satisfies E2EConfig;
