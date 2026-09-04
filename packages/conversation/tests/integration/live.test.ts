/**
 * The backend against a real AI SDK agent through the real SDK: a two-tool
 * support agent, one tool gated on approval. Opt in with
 * `E2E_CONVERSATION_LIVE=1` and a gateway key; without them the suite is
 * skipped loudly rather than passing. This proves the transport-drive loop,
 * tool-call recording, and the approval resume against the SDK, without the
 * e2e runner or a second model (the test itself plays the user).
 */

import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@e2edev/e2e/backend';

const enabled = process.env['E2E_CONVERSATION_LIVE'] === '1' && (process.env['AI_GATEWAY_API_KEY'] ?? '') !== '';

function operation(): OperationContext {
  return { signal: AbortSignal.timeout(60_000), timeoutMs: 60_000, runId: 'live', attemptId: 'a1' };
}

describe.skipIf(!enabled)('conversation backend against a real agent', () => {
  it('records a gated tool, holds it until approved, then lets it run', async () => {
    const [{ conversation, surfaceOf }, ai, { z }] = await Promise.all([
      import('../../src/backend.ts'),
      import('ai'),
      import('zod'),
    ]);
    const { Experimental_Agent: Agent, tool, stepCountIs, createGateway } = ai as unknown as {
      Experimental_Agent: new (options: unknown) => unknown;
      tool: (config: unknown) => unknown;
      stepCountIs: (n: number) => unknown;
      createGateway: (options: { apiKey: string }) => { languageModel(id: string): unknown };
    };
    const gateway = createGateway({ apiKey: process.env['AI_GATEWAY_API_KEY'] as string });

    const wired: { to: string; amount: number }[] = [];
    const agent = new Agent({
      model: gateway.languageModel(process.env['E2E_CONVERSATION_MODEL'] ?? 'openai/gpt-5.6-luna'),
      instructions: 'You are a banking assistant. When asked to send money, call the wire tool. Be concise.',
      tools: {
        balance: tool({
          description: 'Get the account balance in dollars.',
          inputSchema: z.object({}),
          execute: async () => ({ balance: 1000 }),
        }),
        wire: tool({
          description: 'Wire money to a recipient.',
          inputSchema: z.object({ to: z.string(), amount: z.number() }),
          needsApproval: true,
          execute: async ({ to, amount }: { to: string; amount: number }) => {
            wired.push({ to, amount });
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(6),
    });

    const backend = conversation({ agent, name: 'bank' });
    const surface = surfaceOf(backend)!;
    await backend.init!({
      runId: 'live',
      targetName: 'bank',
      projectRoot: process.cwd(),
      app: { allowedOrigins: [] },
      testIdAttribute: 'data-testid',
      headed: false,
      signal: new AbortController().signal,
    });
    await backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: new AbortController().signal });
    try {
      await surface.send('Wire $50 to Bob.', operation());
      expect(surface.status()).toBe('awaiting-approval');
      expect(wired).toHaveLength(0);
      const pending = surface.soleApproval();
      expect(pending.name).toBe('wire');
      expect(surface.toolCalls('wire')[0]!.input).toMatchObject({ amount: 50 });

      await surface.respond(pending.approvalId, true, operation());
      expect(surface.status()).toBe('ready');
      expect(wired).toEqual([{ to: 'Bob', amount: 50 }]);
      expect(surface.toolCalls('wire').at(-1)!.state).toBe('output-available');
      expect(surface.lastText().length).toBeGreaterThan(0);
      expect(await backend.url!(operation())).toMatch(/^app:\/\/conversation\/bank\//);
    } finally {
      await backend.endAttempt!({ signal: new AbortController().signal, timeoutMs: 5_000 });
      await backend.dispose!({ signal: new AbortController().signal, timeoutMs: 5_000 });
    }
  });
});
