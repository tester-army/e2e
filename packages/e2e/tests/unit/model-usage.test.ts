import { describe, expect, it } from 'vitest';
import { ModelUsage } from '../../src/agent/usage.ts';

const provenance = { provider: 'test', model: 'test', endpoint: 'default', adapterVersion: '1', policyVersion: '1' };

describe('model usage accounting', () => {
  it('totals complete provider reports and preserves the peak per call', () => {
    const usage = new ModelUsage();
    usage.record({ inputTokens: 10, outputTokens: 3, estimatedCostUsd: 0.1 });
    usage.record({ inputTokens: 20, outputTokens: 7, estimatedCostUsd: 0.2 });
    expect(usage.report(provenance, 2)).toMatchObject({ tokenAccounting: 'provider', inputTokens: 30, outputTokens: 10, peakTokensPerCall: 27 });
    expect(usage.report(provenance, 2).estimatedCostUsd).toBeCloseTo(0.3);
  });

  it.each([{}, { inputTokens: 1 }, { inputTokens: 1, outputTokens: 2, accounting: 'adapter-upper-bound' as const }])('keeps mixed usage non-authoritative after later complete reports: %j', (partial) => {
    const usage = new ModelUsage();
    usage.record(partial);
    usage.record({ inputTokens: 10, outputTokens: 3 });
    expect(usage.report(provenance, 2).tokenAccounting).toBe('adapter-upper-bound');
  });

  it('marks calls without returned usage as incomplete and rejects malformed counters and cost', () => {
    const usage = new ModelUsage();
    usage.record({ inputTokens: 10, outputTokens: 3 });
    expect(usage.report(provenance, 2).tokenAccounting).toBe('adapter-upper-bound');
    usage.record({ inputTokens: -1, outputTokens: Infinity, estimatedCostUsd: NaN });
    expect(usage.report(provenance, 2)).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(usage.report(provenance, 2).estimatedCostUsd).toBeUndefined();
  });

  it('caps overflowing token sums and preserves non-authoritative accounting', () => {
    const usage = new ModelUsage();
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(usage.record({ inputTokens: maximum, outputTokens: maximum })).toBe(maximum);
    usage.record({ inputTokens: 2, outputTokens: 2 });
    usage.record({ inputTokens: 0, outputTokens: 0 });
    expect(usage.report(provenance, 3)).toMatchObject({
      tokenAccounting: 'adapter-upper-bound', inputTokens: maximum,
      outputTokens: maximum, peakTokensPerCall: maximum,
    });
  });

  it('omits an overflowing cost total even after later finite costs arrive', () => {
    const usage = new ModelUsage();
    usage.record({ inputTokens: 1, outputTokens: 1, estimatedCostUsd: Number.MAX_VALUE });
    expect(usage.report(provenance, 1).estimatedCostUsd).toBe(Number.MAX_VALUE);
    usage.record({ inputTokens: 1, outputTokens: 1, estimatedCostUsd: Number.MAX_VALUE });
    usage.record({ inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.25 });
    expect(usage.report(provenance, 3)).not.toHaveProperty('estimatedCostUsd');
    expect(usage.report(provenance, 3)).toMatchObject({ inputTokens: 3, outputTokens: 3 });
  });
});
