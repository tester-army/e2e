/**
 * A small AI SDK v7 agent, the app under test for the conversation suite: a
 * bank support assistant with three tools. `balance` and `history` run freely;
 * `wire` moves money and is gated on approval, so the conversation backend can
 * hold it and a test can decide. `wired` records every transfer that actually
 * executed, the side-effect oracle the suite asserts on.
 *
 * This stands in for "an agent someone built with the AI SDK". It is created
 * per call so each attempt gets a fresh ledger.
 */

import { Experimental_Agent as Agent, createGateway, stepCountIs, tool } from 'ai';
import { z } from 'zod';

export interface Ledger {
  readonly wired: { to: string; amount: number }[];
}

export interface SupportAgent {
  readonly agent: unknown;
  readonly ledger: Ledger;
}

let current: Ledger = { wired: [] };

/** The ledger of the agent built most recently, for the suite's side-effect checks. */
export function currentLedger(): Ledger {
  return current;
}

/** Builds one support agent and the ledger its wire tool writes to. */
export function createSupportAgent(): SupportAgent {
  const ledger: Ledger = { wired: [] };
  current = ledger;
  const gateway = createGateway({ apiKey: process.env['AI_GATEWAY_API_KEY'] ?? '' });
  const balances: Record<string, number> = { checking: 1240, savings: 5300 };

  const agent = new Agent({
    model: gateway.languageModel(process.env['E2E_SUPPORT_MODEL'] ?? 'openai/gpt-5.6-luna'),
    instructions: [
      'You are the support assistant for a bank. Answer in one or two sentences.',
      'Use the balance tool to read an account balance and the history tool for recent transfers.',
      'To send money, call the wire tool; it is gated and a human will approve or deny it.',
      'Never claim a transfer succeeded unless the wire tool returned ok. If a wire is denied, apologise and do not retry.',
    ].join(' '),
    tools: {
      balance: tool({
        description: 'Get the balance of one account in dollars.',
        inputSchema: z.object({ account: z.enum(['checking', 'savings']) }),
        execute: async ({ account }) => ({ account, balance: balances[account] ?? 0 }),
      }),
      history: tool({
        description: 'List recent wire transfers this session executed.',
        inputSchema: z.object({}),
        execute: async () => ({ transfers: ledger.wired }),
      }),
      wire: tool({
        description: 'Wire money to a recipient. Requires human approval before it runs.',
        inputSchema: z.object({ to: z.string(), amount: z.number().positive() }),
        needsApproval: true,
        execute: async ({ to, amount }) => {
          ledger.wired.push({ to, amount });
          return { ok: true, to, amount };
        },
      }),
    },
    stopWhen: stepCountIs(8),
  });

  return { agent, ledger };
}
