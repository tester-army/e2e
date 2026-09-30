import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      },
    },
  ],
  // Model behind every agent.* step.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    },
  },
  credentials: {
    admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
  },
} satisfies E2EConfig;
