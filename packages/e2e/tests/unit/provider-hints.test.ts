import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { promptCacheKey, providerHints, type ProviderModelRef } from '../../src/agent/model/provider-hints.ts';

const BREAKPOINT = { cacheControl: { type: 'ephemeral' } };

describe('providerHints for Anthropic', () => {
  const hints = providerHints({ provider: 'gateway', modelId: 'anthropic/claude-haiku-4.5' });

  it('recognizes the provider through a gateway id or a direct provider name', () => {
    const direct = providerHints({ provider: 'anthropic.messages', modelId: 'claude-sonnet-4-5' });
    expect(direct.instructions('rules')).toEqual(hints.instructions('rules'));
  });

  it.each([
    { provider: 'amazon-bedrock', modelId: 'eu.anthropic.claude-sonnet-4-6' },
    { provider: 'amazon-bedrock', modelId: 'anthropic.claude-opus-5-5' },
    { provider: 'vertex.anthropic.messages', modelId: 'claude-opus-5-5' },
    { provider: 'openrouter.chat', modelId: 'anthropic/claude-sonnet-5-5' },
  ])('recognizes Claude on %j, where the same check runs', (model) => {
    const platform = providerHints(model);
    expect(platform.instructions('rules')).toEqual(hints.instructions('rules'));
    const history: ModelMessage[] = [
      { role: 'user', content: 'step' },
      { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'ok' }] },
    ];
    expect(platform.afterEdit(history, 0)).toEqual([history[0], { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
  });

  it('marks the system prompt as a breakpoint and adds no request options', () => {
    expect(hints.instructions('rules')).toEqual({
      role: 'system',
      content: 'rules',
      providerOptions: { anthropic: BREAKPOINT },
    });
    expect(hints.providerOptions(undefined, 'rules')).toBeUndefined();
    expect(hints.providerOptions({ anthropic: { thinking: 'low' } }, 'rules')).toEqual({ anthropic: { thinking: 'low' } });
  });

  it('moves the conversation breakpoint to the newest message each turn', () => {
    const first: ModelMessage[] = [{ role: 'user', content: 'step' }];
    const marked = hints.markLatest(first);
    expect(marked[0]?.providerOptions).toEqual({ anthropic: BREAKPOINT });

    const second = hints.markLatest([
      ...marked,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'tap', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'tap', output: { type: 'text', value: 'ok' } }] },
    ]);
    expect(second[0]?.providerOptions).toBeUndefined();
    expect(second[1]?.providerOptions).toBeUndefined();
    expect(second[2]?.providerOptions).toEqual({ anthropic: BREAKPOINT });
    expect(second.filter((message) => message.providerOptions?.['anthropic'] !== undefined)).toHaveLength(1);
  });

  it('keeps unrelated provider options on a message that loses its breakpoint', () => {
    const [kept] = hints.markLatest([
      { role: 'user', content: 'a', providerOptions: { anthropic: { ...BREAKPOINT, other: 1 }, openai: { x: 1 } } },
      { role: 'user', content: 'b' },
    ]);
    expect(kept?.providerOptions).toEqual({ anthropic: { other: 1 }, openai: { x: 1 } });
  });

  describe('after an edit', () => {
    const reasoning = { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'sig' } } } as const;
    const call = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'tap', input: {} }) as const;
    const result = (id: string): ModelMessage => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: 'tap', output: { type: 'text', value: 'ok' } }],
    });
    const history: ModelMessage[] = [
      { role: 'user', content: 'step' },
      { role: 'assistant', content: [reasoning, call('c1')] },
      result('c1'),
      { role: 'assistant', content: [reasoning] },
      { role: 'user', content: 'notice' },
      { role: 'assistant', content: [reasoning, call('c2')] },
      result('c2'),
    ];

    it('drops the reasoning from the edited message on, and a reply that was only reasoning', () => {
      const after = hints.afterEdit(history, 2);
      // Untouched messages carry over as the same objects; the edited one and the reply after it keep their calls.
      expect(after.slice(0, 3)).toEqual([history[0], history[1], history[2]]);
      expect(after[1]).toBe(history[1]);
      expect(after.slice(3)).toEqual([history[4], { role: 'assistant', content: [call('c2')] }, history[6]]);
    });

    it('returns the history itself when nothing from the edit on reasoned', () => {
      expect(hints.afterEdit(history, 6)).toBe(history);
    });
  });
});

describe('providerHints for OpenAI-shaped providers', () => {
  const hints = providerHints({ provider: 'gateway', modelId: 'openai/gpt-5.6-luna-fast' });

  it('routes with a key derived from the system prompt, stores nothing, and lets the caller override both', () => {
    expect(hints.instructions('rules')).toBe('rules');
    expect(hints.providerOptions(undefined, 'rules')).toEqual({
      openai: { promptCacheKey: promptCacheKey('rules'), store: false },
    });
    expect(hints.providerOptions({ openai: { reasoningEffort: 'low' } }, 'rules')).toEqual({
      openai: { promptCacheKey: promptCacheKey('rules'), store: false, reasoningEffort: 'low' },
    });
    expect(hints.providerOptions({ openai: { promptCacheKey: 'mine', store: true } }, 'rules')).toEqual({
      openai: { promptCacheKey: 'mine', store: true },
    });
    expect(promptCacheKey('rules')).toBe(promptCacheKey('rules'));
    expect(promptCacheKey('rules')).not.toBe(promptCacheKey('other rules'));
  });

  it('keys the same options as the AI SDK does: openai directly, azure for Azure OpenAI', () => {
    const direct = providerHints({ provider: 'openai.responses', modelId: 'gpt-4o' });
    expect(direct.providerOptions(undefined, 'rules')).toEqual(hints.providerOptions(undefined, 'rules'));
    const azure = providerHints({ provider: 'azure.responses', modelId: 'my-deployment' });
    expect(azure.instructions('rules')).toBe('rules');
    expect(azure.providerOptions({ azure: { reasoningEffort: 'low' } }, 'rules')).toEqual({
      azure: { promptCacheKey: promptCacheKey('rules'), store: false, reasoningEffort: 'low' },
    });
  });

  it('does not touch the messages, after an edit included: OpenAI binds no reasoning to the prefix', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'step' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'ok' }] },
    ];
    expect(hints.markLatest(messages)).toBe(messages);
    expect(hints.afterEdit(messages, 0)).toBe(messages);
  });
});

/** The request body a hinted call sends through a provider built with `create`, which receives the capturing fetch. */
async function hintedBody(create: (fetch: typeof globalThis.fetch) => LanguageModelV4): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const model = create((_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.reject(new Error('captured'));
  });
  const providerOptions = providerHints(model as ProviderModelRef).providerOptions(undefined, 'rules');
  const call = model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'step' }] }],
    ...(providerOptions === undefined ? {} : { providerOptions: providerOptions as never }),
  });
  await expect(call).rejects.toThrow();
  return body;
}

describe('providerHints for chat completions providers', () => {
  it.each(['openai', 'openai-proxy'])('adds nothing to the body of an OpenAI-compatible provider named %s', async (name) => {
    const body = await hintedBody((fetch) => createOpenAICompatible({ name, baseURL: 'http://127.0.0.1:1/v1', fetch })('m'));
    expect(body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'step' }] });
  });

  it.each(['openai', 'openai-eu'])('keeps the cache key on an OpenAI Responses model named %s', async (name) => {
    const body = await hintedBody((fetch) => createOpenAI({ name, apiKey: 'test-key', fetch }).responses('gpt-6-luna'));
    expect(body).toMatchObject({ prompt_cache_key: promptCacheKey('rules'), store: false });
  });
});

describe('providerHints for other providers', () => {
  it.each([
    { provider: 'gateway', modelId: 'google/gemini-3-flash' },
    { provider: 'openai.chat', modelId: 'gpt-4o' },
    { provider: 'azure.chat', modelId: 'my-deployment' },
    { provider: 'openai-proxy.chat', modelId: 'openai/gpt-4o' },
    { provider: 'mock-provider', modelId: 'mock-model' },
    undefined,
  ])('changes nothing for %j', (model) => {
    const hints = providerHints(model);
    const base = { google: { thinkingConfig: {} } };
    const messages: ModelMessage[] = [{ role: 'user', content: 'step' }];
    expect(hints.instructions('rules')).toBe('rules');
    expect(hints.providerOptions(base, 'rules')).toBe(base);
    expect(hints.markLatest(messages)).toBe(messages);
  });
});
