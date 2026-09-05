import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { FailureAnalyzer } from '../../src/types.ts';
import { createFakeModel } from '../helpers/fake-model.ts';

const ROOT = '/tmp/e2e-analysis-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;
const TARGETS = [{ name: 'web', platform: 'web' } as const];

function resolve(
  raw: Parameters<typeof resolveConfig>[0],
  options: { env?: NodeJS.ProcessEnv; cli?: { analyze?: boolean } } = {},
) {
  return resolveConfig(
    { targets: TARGETS, ...raw },
    { projectRoot: ROOT, env: options.env ?? BASE_ENV, ...(options.cli === undefined ? {} : { cli: options.cli }) },
  );
}

const analyzer: FailureAnalyzer = {
  name: 'custom',
  analyze: async () => ({ classification: 'unknown', confidence: 'low', summary: 'n/a', evidence: [] }),
};

describe('analysis config', () => {
  it('is off unless configured or asked for on the command line', () => {
    expect(resolve({}).analysis).toBeUndefined();
    expect(resolve({}, { cli: { analyze: true } }).analysis).toBeDefined();
  });

  it('applies defaults and falls back to the agent model', () => {
    const config = resolve({ agent: { model: 'openai/gpt-5' }, analysis: {} });
    expect(config.analysis).toMatchObject({ maxFailures: 10, vision: false, source: true, analyzer: undefined });
    expect(config.analysis?.model).toMatchObject({ kind: 'gateway', provider: 'openai', id: 'gpt-5' });
  });

  it('prefers its own model, then the environment override, over the agent model', () => {
    const own = resolve({ agent: { model: 'openai/gpt-5' }, analysis: { model: 'google/gemini-3-flash' } });
    expect(own.analysis?.model).toMatchObject({ provider: 'google', id: 'gemini-3-flash' });
    const fromEnv = resolve(
      { agent: { model: 'openai/gpt-5' }, analysis: {} },
      { env: { ...BASE_ENV, E2E_ANALYSIS_MODEL: 'anthropic/claude-haiku' } as NodeJS.ProcessEnv },
    );
    expect(fromEnv.analysis?.model).toMatchObject({ provider: 'anthropic', id: 'claude-haiku' });
  });

  it('leaves the model undefined when nothing configures one', () => {
    expect(resolve({ analysis: {} }).analysis?.model).toBeUndefined();
  });

  it('accepts a model instance and a custom analyzer', () => {
    const model = createFakeModel(() => ({}), { modelId: 'analyst' });
    const config = resolve({ analysis: { model, analyzer, maxFailures: 3, vision: true, source: false } });
    expect(config.analysis).toMatchObject({ maxFailures: 3, vision: true, source: false });
    expect(config.analysis?.model).toMatchObject({ kind: 'instance', id: 'analyst' });
    expect(config.analysis?.analyzer).toBe(analyzer);
  });

  it('rejects unknown keys, bad shapes, and out-of-range limits', () => {
    expect(() => resolve({ analysis: { bogus: true } as never })).toThrow(/unknown analysis config key "bogus"/);
    expect(() => resolve({ analysis: 'yes' as never })).toThrow(/analysis must be an options object/);
    expect(() => resolve({ analysis: { analyzer: { name: 'x' } as never } })).toThrow(/FailureAnalyzer/);
    expect(() => resolve({ analysis: { maxFailures: 0 } })).toThrow(/analysis.maxFailures/);
    expect(() => resolve({ analysis: { vision: 'yes' as never } })).toThrow(/analysis.vision/);
  });

  it('digests the analyzer by name and a model instance by identity', () => {
    const model = createFakeModel(() => ({}), { modelId: 'analyst' });
    const first = resolve({ analysis: { model, analyzer } });
    const second = resolve({
      analysis: { model: createFakeModel(() => ({}), { modelId: 'analyst' }), analyzer: { ...analyzer } },
    });
    const differentModel = resolve({
      analysis: { model: createFakeModel(() => ({}), { modelId: 'other' }), analyzer },
    });
    expect(first.configDigest).toBe(second.configDigest);
    expect(first.configDigest).not.toBe(differentModel.configDigest);
  });
});
