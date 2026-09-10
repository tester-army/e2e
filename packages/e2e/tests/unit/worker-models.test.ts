import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';

const ENV = { APP_URL: 'http://localhost:3000', E2E_MODEL_API_KEY: 'test-key' } as NodeJS.ProcessEnv;

function agents(raw: NonNullable<Parameters<typeof resolveConfig>[0]['agents']>) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], agents: raw }, { projectRoot: '/tmp/e2e-worker-models', env: ENV }).agents;
}

describe('WorkerModels', () => {
  it('shares one adapter between agents that name the same model, and builds another for a different one', () => {
    const resolved = agents({
      default: { model: 'openai/gpt-5.6-luna-fast' },
      buyer: { model: 'openai/gpt-5.6-luna-fast', context: 'a buyer' },
      thorough: { model: 'anthropic/claude-opus-5' },
    });
    const models = new WorkerModels(() => undefined);
    const shared = models.build(resolved.get('default')!.model);
    expect(models.build(resolved.get('buyer')!.model)).toBe(shared);
    expect(models.build(resolved.get('thorough')!.model)).not.toBe(shared);
    // The same reference resolves to distinct objects per agent; the adapter does not care.
    expect(resolved.get('default')!.model).not.toBe(resolved.get('buyer')!.model);
  });

  it('keeps models with another endpoint or credential apart', () => {
    const resolved = agents({
      default: { model: 'openai/gpt-5.6-luna-fast' },
      other: { model: { provider: 'openai', id: 'gpt-5.6-luna-fast', apiKeyEnv: 'OTHER_KEY' } },
    });
    const models = new WorkerModels(() => undefined);
    const first = models.build(resolved.get('default')!.model);
    let second: unknown;
    try {
      second = models.build(resolved.get('other')!.model);
    } catch (cause) {
      // A missing OTHER_KEY is its own failure; either way it is not the shared adapter.
      second = cause;
    }
    expect(second).not.toBe(first);
  });

  it('preflights each agent once, exempts a custom executor without a model, and reports a failure to the run once then rethrows it', () => {
    const failures: string[] = [];
    const models = new WorkerModels((error) => failures.push(error.code));
    const resolved = agents({
      default: { model: 'openai/gpt-5.6-luna-fast' },
      brain: { executor: { name: 'brain', async runStep() { return { status: 'passed' as const, summary: 'ok' }; } } },
      keyless: { model: { provider: 'openai', id: 'gpt-5.6-luna-fast', apiKeyEnv: 'E2E_TEST_KEY_THAT_IS_NOT_SET' } },
    });
    models.preflight(resolved.get('default')!);
    models.preflight(resolved.get('default')!);
    models.preflight(resolved.get('brain')!);
    expect(failures).toEqual([]);
    // The agent without a credential fails once to the run, and every later preflight rethrows the same failure.
    expect(() => models.preflight(resolved.get('keyless')!)).toThrow(/MODEL_UNAVAILABLE|E2E_TEST_KEY_THAT_IS_NOT_SET/);
    expect(() => models.preflight(resolved.get('keyless')!)).toThrow();
    expect(() => models.preflight(resolved.get('default')!)).toThrow();
    expect(failures).toEqual(['MODEL_UNAVAILABLE']);
  });
});
