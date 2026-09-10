import { describe, expect, it } from 'vitest';
import type { SdkLanguageModel } from '../../src/config/agent.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';

const ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

function model(modelId: string): SdkLanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'gateway',
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not called')),
    doStream: () => Promise.reject(new Error('not called')),
  } as unknown as SdkLanguageModel;
}

function agents(raw: NonNullable<Parameters<typeof resolveConfig>[0]['agents']>) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], agents: raw }, { projectRoot: '/tmp/e2e-worker-models', env: ENV }).agents;
}

describe('WorkerModels', () => {
  it('shares one adapter between agents that hold the same model instance, and builds another for a different one', () => {
    const shared = model('openai/gpt-5.6-luna-fast');
    const resolved = agents({
      default: { model: shared },
      buyer: { model: shared, context: 'a buyer' },
      thorough: { model: model('anthropic/claude-opus-5') },
      // The same id constructed twice is two instances, and two transports as far as the runner can tell.
      twin: { model: model('openai/gpt-5.6-luna-fast') },
    });
    const models = new WorkerModels(() => undefined);
    const adapter = models.build(resolved.get('default')!.model);
    expect(models.build(resolved.get('buyer')!.model)).toBe(adapter);
    expect(models.build(resolved.get('thorough')!.model)).not.toBe(adapter);
    expect(models.build(resolved.get('twin')!.model)).not.toBe(adapter);
  });

  it('preflights each agent once, exempts a custom executor without a model, and reports a missing model to the run once then rethrows it', () => {
    const failures: string[] = [];
    const models = new WorkerModels((error) => failures.push(error.code));
    const resolved = agents({
      default: { model: model('openai/gpt-5.6-luna-fast') },
      brain: { executor: { name: 'brain', async runStep() { return { status: 'passed' as const, summary: 'ok' }; } } },
      modelless: { context: 'no model anywhere' },
    });
    models.preflight(resolved.get('default')!);
    models.preflight(resolved.get('default')!);
    models.preflight(resolved.get('brain')!);
    expect(failures).toEqual([]);
    // The built-in agent without a model fails once to the run, and every later preflight rethrows the same failure.
    expect(() => models.preflight(resolved.get('modelless')!)).toThrow(/MODEL_UNAVAILABLE|requires a model/);
    expect(() => models.preflight(resolved.get('modelless')!)).toThrow();
    expect(() => models.preflight(resolved.get('default')!)).toThrow();
    expect(failures).toEqual(['MODEL_UNAVAILABLE']);
  });
});
