/**
 * Dogfood config: the built-in agent extended with project tools (seed/reset
 * over the app's test API), passed as the `agent` value itself. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/e2e/dist/cli/bin.js run --config e2e.dogfood.config.ts
 */

import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createAgent, defineTool } from 'e2e/agent';
import { gateway, tool } from 'ai';
import { z } from 'zod';

const APP_URL = 'http://127.0.0.1:4310';

const seedExpenses = defineTool(
  tool({
    description: 'Seed N expenses through the test API. Reload the page afterwards to see them.',
    inputSchema: z.object({ count: z.number().int().min(1).max(10) }),
    execute: async ({ count }) => {
      const response = await fetch(`${APP_URL}/api/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      return `Seeded: ${await response.text()}`;
    },
  }),
  { mutates: true },
);

const resetExpenses = defineTool(
  tool({
    description: 'Delete every expense through the test API. Reload the page afterwards.',
    inputSchema: z.object({}),
    execute: async () => {
      await fetch(`${APP_URL}/api/reset`, { method: 'POST' });
      return 'All expenses deleted.';
    },
  }),
  { mutates: true },
);

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-dogfood',
  tests: 'tests-dogfood/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web({
        url: APP_URL,
        command: { executable: 'node', args: ['dogfood/server.mjs'], env: { PORT: '4310' } },
      }),
    },
  ],
  timeout: 300_000,
  agents: {
    default: {
      executor: createAgent({
        model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
        tools: { seed_expenses: seedExpenses, reset_expenses: resetExpenses },
        system:
          'The app under test is a small expense-claims tool. Saves are asynchronous: ' +
          'after submitting, a "Saving…" indicator shows until the save lands.',
      }),
      timeout: 90_000,
    },
  },
} satisfies E2EConfig;
