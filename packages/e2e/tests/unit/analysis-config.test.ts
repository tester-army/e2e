import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import type { FailureAnalyzer, FailureEvidenceProvider, ModelInstance } from '../../src/types.ts';
import { installFakeModel } from '../helpers/fake-model.ts';

const ROOT = '/tmp/e2e-analysis-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

function resolve(raw: Parameters<typeof resolveConfig>[0], cli?: CliOverrides) {
  return resolveConfig(
    { targets: [{ name: 'web', platform: 'web' }], ...raw },
    { projectRoot: ROOT, env: BASE_ENV, ...(cli === undefined ? {} : { cli }) },
  );
}

function model(modelId: string): ModelInstance {
  return installFakeModel(() => ({}), { modelId });
}

const analyzer: FailureAnalyzer = {
  name: 'custom',
  analyze: async () => ({ classification: 'unknown', confidence: 'low', summary: 'n/a', evidence: [] }),
};

const provider: FailureEvidenceProvider = { name: 'git-diff', collect: async () => 'diff --git' };

describe('analysis config', () => {
  it('is off unless configured or asked for on the command line', () => {
    expect(resolve({}).analysis).toBeUndefined();
    expect(resolve({}, { analyze: true }).analysis).toBeDefined();
  });

  it('applies defaults and falls back to the default agent model', () => {
    const config = resolve({ agents: { default: { model: model('agent-model') } }, analysis: {} });
    expect(config.analysis).toMatchObject({
      maxFailures: 10,
      vision: false,
      source: true,
      analyzer: undefined,
      instructions: undefined,
      evidence: [],
    });
    expect(config.analysis?.model).toMatchObject({ provider: 'fake', id: 'agent-model' });
  });

  it('prefers its own model over the agent model', () => {
    const config = resolve({
      agents: { default: { model: model('agent-model') } },
      analysis: { model: model('analyst') },
    });
    expect(config.analysis?.model).toMatchObject({ provider: 'fake', id: 'analyst' });
  });

  it('leaves the model undefined when nothing configures one', () => {
    expect(resolve({ analysis: {} }).analysis?.model).toBeUndefined();
  });

  it('rejects a model string like every other model slot', () => {
    expect(() => resolve({ analysis: { model: 'openai/gpt-5' as never } })).toThrow(
      /analysis.model must be an AI SDK model instance/,
    );
  });

  it('accepts the user seams: instructions, evidence providers, a custom analyzer', () => {
    const config = resolve({
      analysis: {
        model: model('analyst'),
        instructions: '  Locators use data-testid.  ',
        evidence: [provider],
        analyzer,
        maxFailures: 3,
        vision: true,
        source: false,
      },
    });
    expect(config.analysis).toMatchObject({ maxFailures: 3, vision: true, source: false });
    expect(config.analysis?.instructions).toBe('Locators use data-testid.');
    expect(config.analysis?.evidence).toEqual([provider]);
    expect(config.analysis?.analyzer).toBe(analyzer);
  });

  it('drops blank instructions', () => {
    expect(resolve({ analysis: { instructions: '   ' } }).analysis?.instructions).toBeUndefined();
  });

  it('rejects unknown keys, bad shapes, and out-of-range limits', () => {
    expect(() => resolve({ analysis: { bogus: true } as never })).toThrow(/unknown analysis config key "bogus"/);
    expect(() => resolve({ analysis: 'yes' as never })).toThrow(/analysis must be an options object/);
    expect(() => resolve({ analysis: { analyzer: { name: 'x' } as never } })).toThrow(/FailureAnalyzer/);
    expect(() => resolve({ analysis: { evidence: [{ name: 'x' }] as never } })).toThrow(/FailureEvidenceProvider/);
    expect(() => resolve({ analysis: { evidence: [provider, { ...provider }] } })).toThrow(/"git-diff" twice/);
    expect(() => resolve({ analysis: { evidence: provider as never } })).toThrow(/analysis.evidence must be an array/);
    expect(() => resolve({ analysis: { instructions: 5 as never } })).toThrow(/analysis.instructions must be a string/);
    expect(() => resolve({ analysis: { instructions: 'x'.repeat(9_000) } })).toThrow(/at most 8192 bytes/);
    expect(() => resolve({ analysis: { maxFailures: 0 } })).toThrow(/analysis.maxFailures/);
    expect(() => resolve({ analysis: { vision: 'yes' as never } })).toThrow(/analysis.vision/);
    expect(() => resolve({ analysis: { source: 'yes' as never } })).toThrow(/analysis.source/);
  });

  it('never enters the config digest: turning analysis on keeps every cached trace valid', () => {
    const off = resolve({});
    const on = resolve({ analysis: { model: model('analyst'), analyzer, evidence: [provider], instructions: 'x' } });
    expect(on.configDigest).toBe(off.configDigest);
  });
});
