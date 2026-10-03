/**
 * The failure the runner hints exist for happened on the second turn of a
 * step: with storage on, the AI SDK replays a reasoning model's first turn
 * by item id, which a provider that stored nothing cannot resolve. This pins
 * the second request's shape against the installed `@ai-sdk/openai`, driven
 * the way the act loop drives it: a tool-loop agent whose first turn came
 * back as reasoning plus a tool call.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, tool, ToolLoopAgent } from 'ai';
import { describe, expect, it } from 'vitest';
import { promptCacheKey, providerHints, type ProviderModelRef } from '../../src/agent/model/provider-hints.ts';

const USAGE = {
  input_tokens: 3,
  output_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

function response(output: unknown[]): unknown {
  return { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-6-luna', status: 'completed', output, usage: USAGE, incomplete_details: null };
}

const FIRST_TURN = response([
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-1', summary: [] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'tap', arguments: '{}', status: 'completed' },
]);
const SECOND_TURN = response([
  { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
]);

/** Runs two turns and returns the request bodies, in order. */
async function twoTurns(): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = bodies.length === 1 ? FIRST_TURN : SECOND_TURN;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const model = createOpenAI({ apiKey: 'test-key', fetch })('gpt-6-luna');
  const hints = providerHints(model as ProviderModelRef);
  const providerOptions = hints.providerOptions(undefined, 'rules');
  const agent = new ToolLoopAgent({
    model,
    instructions: hints.instructions('rules'),
    tools: { tap: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: () => 'tapped' }) },
    ...(providerOptions === undefined ? {} : { providerOptions: providerOptions as never }),
    stopWhen: stepCountIs(2),
    prepareStep: ({ messages }) => ({ messages: hints.markLatest(messages) }),
  });
  await agent.generate({ prompt: 'tap the thing' });
  return bodies;
}

/** The typed items of a request's input: what follows the instruction and prompt messages, which carry a role only. */
function typedItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return (body['input'] as Record<string, unknown>[]).filter((item) => 'type' in item);
}

describe('the second turn of an OpenAI-shaped step', () => {
  it('replays the first turn inline: encrypted reasoning and the tool exchange, no item reference', async () => {
    const [first, second] = await twoTurns();
    expect(first?.['store']).toBe(false);
    expect(first?.['include']).toContain('reasoning.encrypted_content');
    expect(first?.['prompt_cache_key']).toBe(promptCacheKey('rules'));
    expect(second?.['store']).toBe(false);
    const items = typedItems(second!);
    expect(items.map((item) => item['type'])).toEqual(['reasoning', 'function_call', 'function_call_output']);
    expect(items[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'ENCRYPTED-1' });
    expect(items[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'tap' });
    expect(items[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });
});
