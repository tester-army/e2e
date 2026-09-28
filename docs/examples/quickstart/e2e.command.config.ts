import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  agents: {
    default: createAgent({
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    }),
  },
  targets: [{
    engine: web({
      url: process.env.APP_URL ?? 'http://localhost:3000',
      command: {
        executable: 'npm',
        args: ['run', 'dev'],
        reuseExisting: true,
        log: '.e2e/logs/app.log',
      },
    }),
  }],
} satisfies E2EConfig;
