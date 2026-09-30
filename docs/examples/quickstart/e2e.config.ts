import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
} satisfies E2EConfig;
