import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { cacheFamily, promptCacheHints, promptCacheKey } from '../../src/agent/model/prompt-cache.ts';

const BREAKPOINT = { cacheControl: { type: 'ephemeral' } };

describe('cacheFamily', () => {
  it.each([
    [{ provider: 'gateway', modelId: 'anthropic/claude-haiku-4.5' }, 'anthropic'],
    [{ provider: 'anthropic.messages', modelId: 'claude-sonnet-4-5' }, 'anthropic'],
    [{ provider: 'gateway', modelId: 'openai/gpt-5.6-luna-fast' }, 'openai'],
    [{ provider: 'openai.responses', modelId: 'gpt-4o' }, 'openai'],
    [{ provider: 'azure.responses', modelId: 'my-deployment' }, 'azure'],
    [{ provider: 'gateway', modelId: 'google/gemini-3-flash' }, undefined],
    [{ provider: 'mock-provider', modelId: 'mock-model' }, undefined],
    [undefined, undefined],
  ])('reads the provider family off %j', (model, family) => {
    expect(cacheFamily(model)).toBe(family);
  });
});

describe('promptCacheHints for Anthropic', () => {
  const hints = promptCacheHints({ provider: 'gateway', modelId: 'anthropic/claude-haiku-4.5' });

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

  it('leaves an empty history alone', () => {
    const empty: ModelMessage[] = [];
    expect(hints.markLatest(empty)).toBe(empty);
  });
});

describe('promptCacheHints for OpenAI', () => {
  const hints = promptCacheHints({ provider: 'gateway', modelId: 'openai/gpt-5.6-luna-fast' });

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

  it('does not touch the messages', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'step' }];
    expect(hints.markLatest(messages)).toBe(messages);
  });
});

describe('promptCacheHints for Azure OpenAI', () => {
  it('sends the same request options under the azure key', () => {
    const hints = promptCacheHints({ provider: 'azure.responses', modelId: 'my-deployment' });
    expect(hints.instructions('rules')).toBe('rules');
    expect(hints.providerOptions({ azure: { reasoningEffort: 'low' } }, 'rules')).toEqual({
      azure: { promptCacheKey: promptCacheKey('rules'), store: false, reasoningEffort: 'low' },
    });
  });
});

describe('promptCacheHints for other providers', () => {
  it('changes nothing', () => {
    const hints = promptCacheHints({ provider: 'gateway', modelId: 'google/gemini-3-flash' });
    const base = { google: { thinkingConfig: {} } };
    const messages: ModelMessage[] = [{ role: 'user', content: 'step' }];
    expect(hints.instructions('rules')).toBe('rules');
    expect(hints.providerOptions(base, 'rules')).toBe(base);
    expect(hints.markLatest(messages)).toBe(messages);
  });
});
