import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

const app = {
  url: process.env.APP_URL ?? 'http://localhost:3000',
  command: { executable: 'npm', args: ['run', 'dev'], reuseExisting: true },
};

export default {
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [
    { name: 'chromium', engine: web({ viewport: { width: 1440, height: 900 } }), app },
    { name: 'firefox', engine: web({ browser: 'firefox' }), app },
  ],
  timeout: 180_000,
  workers: 4,
  reporters: ['list', 'junit'],
  video: 'retain-on-failure',
} satisfies E2EConfig;
