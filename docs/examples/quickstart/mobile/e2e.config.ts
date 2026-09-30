import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

export default {
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [{ name: 'ios', engine: mobile({ platform: 'ios' }), app: { bundleId: 'Settings' } }],
  workers: 1,
} satisfies E2EConfig;
