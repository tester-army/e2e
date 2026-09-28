import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  agents: { default: createAgent({ model: gateway('openai/gpt-6-luna-fast') }) },
  targets: [{ engine: web({ url: 'http://localhost:3000' }) }],
} satisfies E2EConfig;
