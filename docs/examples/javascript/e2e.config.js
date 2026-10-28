import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

/** @type {import('e2e').E2EConfig} */
export default {
  tests: 'tests/**/*.e2e.js',
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
};
