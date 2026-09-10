import { describe, expect, it } from 'vitest';
import { readCost } from '../../src/agent/model/sdk.ts';

describe('readCost', () => {
  it('reads what the Vercel AI Gateway billed, falling back to its market estimate on a BYOK route', () => {
    expect(readCost({ gateway: { cost: '0.0012' } })).toBe(0.0012);
    expect(readCost({ gateway: { cost: '0', marketCost: '0.0034' } })).toBe(0.0034);
    expect(readCost({ gateway: { cost: '0' } })).toBe(0);
  });

  it('reads the cost the OpenRouter provider reports in its usage accounting', () => {
    expect(readCost({ openrouter: { provider: 'OpenAI', usage: { promptTokens: 10, completionTokens: 2, cost: 0.00042 } } })).toBe(0.00042);
    // The gateway's figure wins when both are present.
    expect(readCost({ gateway: { cost: '0.2' }, openrouter: { usage: { cost: 0.9 } } })).toBe(0.2);
  });

  it('reports no cost for providers that send none, or send nonsense', () => {
    expect(readCost(undefined)).toBeUndefined();
    expect(readCost({ openrouter: { usage: { promptTokens: 3 } } })).toBeUndefined();
    expect(readCost({ openrouter: { usage: { cost: -1 } } })).toBeUndefined();
    expect(readCost({ openrouter: { usage: 'cheap' } })).toBeUndefined();
    expect(readCost({ 'openai-compatible': { cost: 1 } })).toBeUndefined();
  });
});
