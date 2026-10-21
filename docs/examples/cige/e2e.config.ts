import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { cige } from '@e2e-dev/cige';
import { gateway } from 'ai';
import cigeConfig from './cige.config.ts';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  reporters: ['list', cige(cigeConfig)],
} satisfies E2EConfig;
