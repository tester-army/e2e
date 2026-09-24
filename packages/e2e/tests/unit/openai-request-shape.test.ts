/**
 * What actually reaches OpenAI once the AI SDK serializes a request that
 * carries the runner's provider hints: stateless storage, encrypted reasoning
 * requested in its place, and the prompt-cache routing key. Pinned against the
 * installed `@ai-sdk/openai`, so a provider release that renames or drops a
 * field fails here rather than on a customer's second turn.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { promptCacheKey, providerHints, type ProviderModelRef } from '../../src/agent/model/provider-hints.ts';
import type { ProviderOptions } from '../../src/types.ts';

const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: 'gpt-6-luna',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 3,
    output_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  incomplete_details: null,
};

function capturingProvider() {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { bodies, openai: createOpenAI({ apiKey: 'test-key', fetch }) };
}

async function send(base: ProviderOptions | undefined): Promise<Record<string, unknown>> {
  const { bodies, openai } = capturingProvider();
  const model = openai('gpt-6-luna');
  const hints = providerHints(model as ProviderModelRef);
  const providerOptions = hints.providerOptions(base, 'rules');
  await generateText({
    model,
    system: 'rules',
    prompt: 'hi',
    ...(providerOptions === undefined ? {} : { providerOptions: providerOptions as never }),
  });
  const [body] = bodies;
  if (body === undefined) throw new Error('no request was sent');
  return body;
}

describe('an OpenAI request carrying the runner hints', () => {
  it('stores nothing, asks for encrypted reasoning instead, and routes by the prompt-cache key', async () => {
    const body = await send(undefined);
    expect(body['store']).toBe(false);
    expect(body['include']).toContain('reasoning.encrypted_content');
    expect(body['prompt_cache_key']).toBe(promptCacheKey('rules'));
  });

  it('keeps the caller in charge of storage', async () => {
    const body = await send({ openai: { store: true } });
    expect(body['store']).toBe(true);
    expect(body['include'] ?? []).not.toContain('reasoning.encrypted_content');
  });
});
