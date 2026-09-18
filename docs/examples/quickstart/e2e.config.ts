import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

export default {
  agents: { default: createAgent({ model: gateway('openai/gpt-5.6-luna') }) },
  targets: [{ engine: playwright({ url: 'http://localhost:3000' }) }],
} satisfies E2EConfig;
