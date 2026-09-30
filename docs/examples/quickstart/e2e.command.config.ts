import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://localhost:3000',
      command: {
        executable: 'npm',
        args: ['run', 'dev'],
        reuseExisting: true,
        log: '.e2e/logs/app.log',
      },
    },
  }],
} satisfies E2EConfig;
