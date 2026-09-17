import type { E2EConfig } from 'e2e';
import { web } from '@e2edev/web';
import { gateway } from 'ai';
import { jevAgent } from '@e2edev/jev';

/**
 * The showcase: agentic steps against the public TodoMVC demo, driven by Jev.
 * Every act turn is one evaluation call; the fallback writes only the values
 * a step leaves open. Run with `AI_GATEWAY_API_KEY=... pnpm run demo:headed`
 * to record the browser alongside the terminal.
 */
export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.jev-demo',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      platform: 'web',
      engine: web({ url: 'https://demo.playwright.dev' }),
    },
  ],
  agents: {
    default: {
      executor: jevAgent({ fallback: gateway('openai/gpt-5.6-luna') }),
      model: gateway('openai/gpt-5.6-luna'),
    },
  },
} satisfies E2EConfig;
