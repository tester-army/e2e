import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { createDefaultAnalyzer } from '../../src/analysis/default-analyzer.ts';
import type { FailureContext } from '../../src/types.ts';
import { fakeCalls, installFakeModel } from '../helpers/fake-model.ts';

const CONTEXT: FailureContext = {
  test: { id: 't', titlePath: ['suite', 'case'], file: 'tests/case.e2e.ts' },
  target: { name: 'web', platform: 'web' },
  status: 'failed',
  attempts: [{ index: 0, status: 'failed', error: { category: 'test', code: 'X', message: 'boom' }, steps: [] }],
  error: { category: 'test', code: 'X', message: 'boom' },
};

const VALID = { classification: 'unknown', confidence: 'low', summary: 'No verdict.', evidence: [] };

function analyzer(model: ReturnType<typeof installFakeModel>) {
  const config = resolveConfig(
    { targets: [{ name: 'web', platform: 'web' }], analysis: { model } },
    { projectRoot: '/tmp/e2e-analyzer-repair', env: { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv },
  );
  return createDefaultAnalyzer({
    model: config.analysis!.model!,
    maxInputTokens: config.limits.maxModelTokensPerCall,
    timeoutMs: 10_000,
  });
}

describe('default analyzer repair round', () => {
  it('asks once more, naming the issue, when the first answer leaves the grammar', async () => {
    let calls = 0;
    const model = installFakeModel(() => {
      calls += 1;
      return calls === 1 ? { classification: 'maybe', confidence: 'low', summary: 'x', evidence: [] } : VALID;
    });
    const analysis = await analyzer(model).analyze(CONTEXT, { signal: new AbortController().signal });
    expect(analysis.classification).toBe('unknown');
    expect(fakeCalls).toHaveLength(2);
    expect(fakeCalls[1]!.prompt).toContain('<repair>\nYour previous answer was not a valid failure-analysis object');
    expect(fakeCalls[0]!.prompt).not.toContain('<repair>');
  });

  it('gives up after the second miss', async () => {
    const model = installFakeModel(() => ({ classification: 'maybe', confidence: 'low', summary: 'x', evidence: [] }));
    await expect(analyzer(model).analyze(CONTEXT, { signal: new AbortController().signal })).rejects.toThrow(
      /classification must be one of/,
    );
    expect(fakeCalls).toHaveLength(2);
  });
});
