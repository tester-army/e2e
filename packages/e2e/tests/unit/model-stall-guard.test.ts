import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { generateText } from 'ai';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { withStallGuard } from '../../src/agent/model/sdk.ts';

function answer(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  };
}

describe('withStallGuard', () => {
  it('re-issues a generate that never answers and returns the retry', async () => {
    await loadAiSdk();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => undefined);
        return answer('second attempt');
      },
    });
    const guarded = withStallGuard(model, 50, 3);
    const result = await generateText({ model: guarded, prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('second attempt');
    expect(calls).toBe(2);
  });

  it('gives up after the configured attempts', async () => {
    await loadAiSdk();
    const model = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => undefined) });
    const guarded = withStallGuard(model, 20, 2);
    await expect(generateText({ model: guarded, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(/no answer within 20 ms/);
  });

  it('passes a prompt answer through untouched', async () => {
    await loadAiSdk();
    const model = new MockLanguageModelV4({ doGenerate: async () => answer('fast') });
    const result = await generateText({ model: withStallGuard(model, 1_000, 3), prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('fast');
  });
});
