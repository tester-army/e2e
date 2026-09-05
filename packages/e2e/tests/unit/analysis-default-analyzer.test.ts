import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import {
  buildAnalysisPrompt,
  createDefaultAnalyzer,
  validateAnalysis,
} from '../../src/analysis/default-analyzer.ts';
import { pngDimensions } from '../../src/internal/png.ts';
import type { FailureContext } from '../../src/types.ts';
import { fakeCalls, installFakeModel } from '../helpers/fake-model.ts';

const CONTEXT: FailureContext = {
  test: { id: 'tests/forms.e2e.ts::forms::saves', titlePath: ['forms', 'saves'], file: 'tests/forms.e2e.ts' },
  target: { name: 'web', platform: 'web' },
  status: 'failed',
  attempts: [
    {
      index: 0,
      status: 'failed',
      error: { category: 'test', code: 'ASSERTION_FAILED', message: 'expected "Saved" but found "Saved!"', phase: 'body' },
      steps: [
        { index: 0, kind: 'app', api: 'app.open', label: '/forms', status: 'passed', durationMs: 120 },
        {
          index: 1,
          kind: 'assertion',
          api: 'expect.toHaveText',
          label: 'status "Save result"',
          status: 'failed',
          durationMs: 5000,
          error: { code: 'ASSERTION_FAILED', message: 'expected "Saved" but found "Saved!"' },
        },
      ],
    },
  ],
  error: { category: 'test', code: 'ASSERTION_FAILED', message: 'expected "Saved" but found "Saved!"', phase: 'body' },
  source: {
    file: 'tests/forms.e2e.ts',
    line: 12,
    column: 5,
    lines: ['  11 |   await button.tap();', '> 12 |   await expect(status).toHaveText("Saved");', '  13 | });'],
  },
  observation: 'status "Save result" "Saved!"\nbutton "Save profile"',
  url: 'http://127.0.0.1:4271/forms',
};

describe('analysis prompt', () => {
  it('frames every evidence section and ends with the instruction', () => {
    const prompt = buildAnalysisPrompt(CONTEXT, { maxBytes: 60_000, withScreenshot: false });
    expect(prompt).toContain('<test>\ntitle: forms › saves');
    expect(prompt).toContain('<error>\ncategory: test\ncode: ASSERTION_FAILED\nphase: body');
    expect(prompt).toContain('<source>\ntests/forms.e2e.ts:12:5\n');
    expect(prompt).toContain('2. ✗ expect.toHaveText "status \\"Save result\\"" 5000ms — ASSERTION_FAILED');
    expect(prompt).toContain('<screen>\nurl: http://127.0.0.1:4271/forms\n\nstatus "Save result" "Saved!"');
    expect(prompt.trimEnd().endsWith('</instruction>')).toBe(true);
    expect(prompt).not.toContain('<previous-attempts>');
  });

  it('lists earlier attempts and their steps when the pair was retried', () => {
    const retried: FailureContext = {
      ...CONTEXT,
      attempts: [
        { index: 0, status: 'failed', error: { category: 'test', code: 'TEST_TIMEOUT', message: 'timed out' }, steps: [] },
        ...CONTEXT.attempts,
      ],
    };
    const prompt = buildAnalysisPrompt(retried, { maxBytes: 60_000, withScreenshot: false });
    expect(prompt).toContain('<previous-attempts>\nattempt 1: failed — TEST_TIMEOUT: timed out\n  (no steps recorded)');
  });

  it('truncates the screen, and only the screen, to fit the input budget', () => {
    const big: FailureContext = { ...CONTEXT, observation: 'x'.repeat(20_000) };
    const prompt = buildAnalysisPrompt(big, { maxBytes: 4_000, withScreenshot: false });
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(4_000 + 256);
    expect(prompt).toContain('[screen truncated for analysis]');
    expect(prompt).toContain('<source>');
    expect(prompt).toContain('<steps>');
  });

  it('drops the screen entirely when no budget is left for it', () => {
    const prompt = buildAnalysisPrompt(CONTEXT, { maxBytes: 100, withScreenshot: false });
    expect(prompt).not.toContain('<screen>');
    expect(prompt).toContain('<instruction>');
  });
});

describe('analysis validation', () => {
  it('accepts the closed grammar and trims, bounds, and drops empty evidence', () => {
    const result = validateAnalysis({
      classification: 'test-bug',
      confidence: 'high',
      summary: '  The expectation is stale.  ',
      evidence: ['error: expected "Saved" but found "Saved!"', '', 'screen: status shows "Saved!"'],
      suggestedFix: 'Update the expected text to "Saved!".',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        classification: 'test-bug',
        confidence: 'high',
        summary: 'The expectation is stale.',
        evidence: ['error: expected "Saved" but found "Saved!"', 'screen: status shows "Saved!"'],
        suggestedFix: 'Update the expected text to "Saved!".',
      },
    });
  });

  it('rejects unknown classifications, keys, and shapes', () => {
    expect(validateAnalysis({ classification: 'maybe', confidence: 'low', summary: 'x', evidence: [] })).toMatchObject({ ok: false });
    expect(validateAnalysis({ classification: 'unknown', confidence: 'low', summary: 'x', evidence: [], extra: 1 })).toMatchObject({ ok: false, issue: 'unexpected key "extra"' });
    expect(validateAnalysis({ classification: 'unknown', confidence: 'low', summary: '', evidence: [] })).toMatchObject({ ok: false });
    expect(validateAnalysis([])).toMatchObject({ ok: false });
  });
});

describe('default analyzer', () => {
  it('sends the prompt to the configured model and reports its usage', async () => {
    const model = installFakeModel((call) => {
      expect(call.schemaName).toBe('failure-analysis');
      expect(call.system).toContain('You are the failure analyst');
      expect(call.prompt).toContain('<screen>');
      return {
        classification: 'test-bug',
        confidence: 'high',
        summary: 'The status reads "Saved!" while the test expects "Saved".',
        evidence: ['error: expected "Saved" but found "Saved!"'],
        suggestedFix: 'Expect "Saved!".',
      };
    });
    const config = resolveConfig(
      { targets: [{ name: 'web', platform: 'web' }], analysis: { model } },
      { projectRoot: '/tmp/e2e-analyzer', env: { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv },
    );
    const analyzer = createDefaultAnalyzer({
      model: config.analysis!.model!,
      maxInputTokens: config.limits.maxModelTokensPerCall,
      timeoutMs: 10_000,
    });
    const analysis = await analyzer.analyze(CONTEXT, { signal: new AbortController().signal });
    expect(analysis.classification).toBe('test-bug');
    expect(analyzer.lastUsage()).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(analyzer.provenance.model).toBe('scripted');
    expect(fakeCalls).toHaveLength(1);
  });
});

describe('pngDimensions', () => {
  it('reads the IHDR geometry and rejects anything else', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(png.buffer).setUint32(16, 1280);
    new DataView(png.buffer).setUint32(20, 720);
    expect(pngDimensions(png)).toEqual({ width: 1280, height: 720 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(pngDimensions(new TextEncoder().encode('not a png at all, just text'))).toBeUndefined();
  });
});
