import { APICallError, createGateway } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import { createAgent } from '../../src/agent/default-agent.ts';
import type { SdkLanguageModel } from '../../src/config/agent.ts';

const ROOT = '/tmp/e2e-agent-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

/** A structurally valid AI SDK model that must never be called. */
function fakeModel(provider: string, modelId: string): SdkLanguageModel {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not called')),
    doStream: () => Promise.reject(new Error('not called')),
  } as unknown as SdkLanguageModel;
}

function resolve(
  raw: Parameters<typeof resolveConfig>[0],
  env: NodeJS.ProcessEnv = BASE_ENV,
  cli?: CliOverrides,
) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], ...raw }, {
    projectRoot: ROOT,
    env,
    ...(cli === undefined ? {} : { cli }),
  });
}

describe('agent config defaults', () => {
  it('applies the specification budgets and local cache mode', () => {
    const config = resolve({});
    expect(config.agent.maxSteps).toBe(25);
    expect(config.agent.maxModelCalls).toBe(25);
    expect(config.agent.timeout).toBe(30_000);
    expect(config.agent.maxObservationBytes).toBe(262_144);
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.context).toBeUndefined();
  });

  it('rejects vision, the removed project-wide pixel default', () => {
    expect(() => resolve({ agents: { default: { vision: true } } } as never)).toThrow(
      /unknown agents\.default key "vision"/,
    );
  });

  it('rejects visionModel, the key the removed judgment model tier used', () => {
    expect(() => resolve({ agents: { default: { visionModel: fakeModel('fake', 'grounding') } } } as never)).toThrow(
      /unknown agents\.default key "visionModel"/,
    );
  });

  it('passes agent.providerOptions through untouched, defaulting to none', () => {
    expect(resolve({}).agent.providerOptions).toBeUndefined();
    const providerOptions = { openai: { reasoningEffort: 'low' }, google: { thinkingConfig: { thinkingBudget: 0 } } };
    expect(resolve({ agents: { default: { providerOptions } } }).agent.providerOptions).toEqual(providerOptions);
  });

  it('rejects agent.providerOptions that is not a record of provider records', () => {
    expect(() => resolve({ agents: { default: { providerOptions: 'low' } } } as never)).toThrow(
      /agents\.default\.providerOptions must be an object/,
    );
    expect(() => resolve({ agents: { default: { providerOptions: [] } } } as never)).toThrow(/agents\.default\.providerOptions/);
    expect(() => resolve({ agents: { default: { providerOptions: { openai: 'low' } } } } as never)).toThrow(
      /agents\.default\.providerOptions\.openai must be an object/,
    );
  });

  it('bounds budgets to 1 through 100 and observation bytes to 1 KiB through 16 MiB', () => {
    expect(() => resolve({ agents: { default: { maxSteps: 0 } } })).toThrow(/maxSteps/);
    expect(() => resolve({ agents: { default: { maxSteps: 101 } } })).toThrow(/maxSteps/);
    expect(() => resolve({ agents: { default: { maxModelCalls: 101 } } })).toThrow(/maxModelCalls/);
    expect(() => resolve({ agents: { default: { maxObservationBytes: 1023 } } })).toThrow(/maxObservationBytes/);
    expect(() => resolve({ agents: { default: { maxObservationBytes: 16_777_217 } } })).toThrow(
      /maxObservationBytes/,
    );
  });

  it('owns the judgment budget: timeout is per agent and independent of actionTimeout', () => {
    const config = resolve({ actionTimeout: 90_000, agents: { default: {}, slow: { timeout: 120_000 } } });
    expect(config.agent.timeout).toBe(30_000);
    expect(config.agents.get('slow')?.timeout).toBe(120_000);
    expect(config.actionTimeout).toBe(90_000);
    expect(() => resolve({ agents: { default: { timeout: 0 } } })).toThrow(/agents\.default\.timeout must be a positive/);
    expect(() => resolve({ agents: { default: { timeout: 1.5 } } })).toThrow(/agents\.default\.timeout/);
  });

  it('rejects unknown agent keys, including the removed cache mode', () => {
    expect(() => resolve({ agents: { default: { retries: 2 } } } as never)).toThrow(/unknown agents\.default key/);
    expect(() => resolve({ agents: { default: { cache: 'always' } } } as never)).toThrow(
      /unknown agents\.default key/,
    );
  });

  it('rejects context larger than the resolved agent-context limit', () => {
    expect(() => resolve({ agents: { default: { context: 'x'.repeat(16_385) } } })).toThrow(/agents\.default\.context is/);
    expect(resolve({ agents: { default: { context: 'be terse' } } }).agent.context).toBe('be terse');
    expect(() =>
      resolve({ agents: { default: { context: 'x'.repeat(2_000) } }, limits: { maxAgentContextBytes: 1_024 } }),
    ).toThrow(/agents\.default\.context is/);
  });
});

describe('agent as the executor itself', () => {
  it('accepts a step executor as the agent value, options staying at defaults', () => {
    const config = resolve({ agents: { default: brain() } });
    expect(config.agent.executor).toMatchObject({ name: 'custom-brain' });
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.maxSteps).toBe(25);
  });

  it('digests a custom agent by name and version, deterministically', () => {
    const first = resolve({ agents: { default: brain() } });
    const again = resolve({ agents: { default: brain() } });
    expect(again.configDigest).toBe(first.configDigest);
    const renamed = resolve({ agents: { default: { ...brain(), name: 'other-brain' } } });
    expect(renamed.configDigest).not.toBe(first.configDigest);
  });

  it('accepts an executor alongside the agent options', () => {
    const config = resolve({ agents: { default: { executor: brain(), maxModelCalls: 40 } } } as never);
    expect(config.agent.executor?.name).toBe('custom-brain');
    expect(config.agent.maxModelCalls).toBe(40);
  });

  it('rejects an executor value that is not a StepExecutor', () => {
    expect(() => resolve({ agents: { default: { executor: { name: 'x' } } } } as never)).toThrow(
      /agents\.default\.executor must be a StepExecutor/,
    );
  });

  it('rejects an agent value that is neither options nor an executor', () => {
    expect(() => resolve({ agents: { default: { runStep: 'nope' } } } as never)).toThrow(
      /unknown agents\.default key/,
    );
  });
});

describe('one canonical model', () => {
  const instance = (modelId: string) => fakeModel('openai', modelId);

  it('uses the model createAgent brought for the judgment tier too', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: createAgent({ model }) } });
    expect(config.agent.executor?.model).toBe(model);
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini', model });
  });

  it('accepts agent.model naming the same model as the executor', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: { executor: createAgent({ model }), model: instance('gpt-5.4-mini') } } });
    expect(config.agent.model).toMatchObject({ model });
  });

  it('rejects agent.model and an executor model that differ', () => {
    expect(() =>
      resolve({ agents: { default: { executor: createAgent({ model: instance('gpt-5.4-mini') }), model: instance('gpt-5.4') } } }),
    ).toThrow(/agents\.default\.model \(openai\/gpt-5\.4\) and the executor's own model \(openai\/gpt-5\.4-mini\) differ; configure the model in one place/);
    expect(() =>
      resolve({ agents: { default: { executor: createAgent({ model: instance('gpt-5.4-mini') }), model: fakeModel('gateway', 'openai/gpt-5.4-mini') } } }),
    ).toThrow(/differ; configure the model in one place/);
  });

  it('leaves a custom executor without a model unconfigured', () => {
    expect(resolve({ agents: { default: brain() } }).agent.model).toBeUndefined();
  });
});

describe('one context', () => {
  it('rejects a built-in agent whose context is not a string, as JavaScript can pass one', () => {
    expect(() => resolve({ agents: { default: createAgent({ model, context: 5 as never }) } })).toThrow(/context/);
  });

  it('ignores a context member on a custom executor, string or not', () => {
    const talkative = { name: 'custom', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }), context: 'not a prompt' };
    expect(resolve({ agents: { default: { executor: talkative, model } } }).agent.context).toBeUndefined();
    const stateful = { name: 'custom', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }), context: Promise.resolve(1) };
    expect(resolve({ agents: { default: { executor: stateful, model } } }).agent.context).toBeUndefined();
  });

  const model = fakeModel('openai', 'gpt-5.4-mini');

  it('uses the context createAgent brought, so the agent needs no second key', () => {
    const config = resolve({ agents: { default: createAgent({ model, context: 'Plans are called tiers.' }) } });
    expect(config.agent.context).toBe('Plans are called tiers.');
    expect(config.agent.model).toMatchObject({ model });
  });

  it('accepts agent.context repeating the executor context', () => {
    const config = resolve({
      agents: { default: { executor: createAgent({ model, context: 'be terse' }), context: 'be terse' } },
    });
    expect(config.agent.context).toBe('be terse');
  });

  it('rejects agent.context and an executor context that differ', () => {
    expect(() =>
      resolve({ agents: { default: { executor: createAgent({ model, context: 'be terse' }), context: 'be thorough' } } }),
    ).toThrow(/agents\.default\.context and the executor's own context \(createAgent\(\{ context \}\)\) differ; configure the context in one place/);
  });

  it('bounds the executor context by the resolved agent-context limit', () => {
    expect(() =>
      resolve({ agents: { default: createAgent({ model, context: 'x'.repeat(2_000) }) }, limits: { maxAgentContextBytes: 1_024 } }),
    ).toThrow(/the executor's own context is 2000 bytes; the resolved maximum is 1024/);
  });

  it('leaves the context unset when neither side names one', () => {
    expect(resolve({ agents: { default: createAgent({ model }) } }).agent.context).toBeUndefined();
    expect(resolve({ agents: { default: { executor: createAgent({ model }) } } }).agent.context).toBeUndefined();
  });
});

describe('judge model', () => {
  const instance = (id: string) => fakeModel('openai', id);

  it('is the model unless one is configured, so judgments always have one rule', () => {
    const model = instance('gpt-5.4-mini');
    expect(resolve({ agents: { default: { model } } }).agent.judge).toMatchObject({ model });
    expect(resolve({ agents: { default: createAgent({ model }) } }).agent.judge).toMatchObject({ model });
    expect(resolve({}).agent.judge).toBeUndefined();
  });

  it('resolves agent.judge apart from agent.model', () => {
    const judge = instance('gpt-5.4');
    const config = resolve({ agents: { default: { model: instance('gpt-5.4-mini'), judge } } });
    expect(config.agent.model).toMatchObject({ id: 'gpt-5.4-mini' });
    expect(config.agent.judge).toMatchObject({ provider: 'openai', id: 'gpt-5.4', model: judge });
  });

  it('uses the judge createAgent brought', () => {
    const judge = instance('gpt-5.4');
    const config = resolve({ agents: { default: createAgent({ model: instance('gpt-5.4-mini'), judge }) } });
    expect(config.agent.executor?.judge).toBe(judge);
    expect(config.agent.judge).toMatchObject({ id: 'gpt-5.4', model: judge });
  });

  it('rejects agent.judge and an executor judge that differ', () => {
    expect(() =>
      resolve({
        agents: {
          default: { executor: createAgent({ model: instance('gpt-5.4-mini'), judge: instance('gpt-5.4') }), judge: instance('gpt-5.5') },
        },
      }),
    ).toThrow(/agents\.default\.judge \(openai\/gpt-5\.5\) and the executor's own judge \(openai\/gpt-5\.4\) differ; configure the judge in one place/);
  });

  it('rejects a string judge the way it rejects a string model', () => {
    expect(() => resolve({ agents: { default: { model: instance('gpt-5.4-mini'), judge: 'openai/gpt-5.4' } } } as never)).toThrow(
      /agents\.default\.judge must be an AI SDK model instance/,
    );
  });
});

describe('model resolution', () => {
  it('accepts a live AI SDK model instance and records its identity', () => {
    const instance = {
      specificationVersion: 'v2',
      provider: 'openai',
      modelId: 'gpt-5.4-mini',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('not called')),
      doStream: () => Promise.reject(new Error('not called')),
    };
    const config = resolve({ agents: { default: { model: instance } } });
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini', model: instance });
    // The live object never enters the digest, and the digest stays stable.
    const again = resolve({ agents: { default: { model: instance } } });
    expect(again.configDigest).toBe(config.configDigest);
  });

  it('records a gateway-built instance by the id the gateway serves', () => {
    const model = createGateway({ apiKey: 'x' }).languageModel('anthropic/claude-sonnet-4.5');
    expect(resolve({ agents: { default: { model } } }).agent.model).toMatchObject({
      provider: 'gateway',
      id: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('has no implicit model: nothing configured and no environment variable is read', () => {
    const config = resolve({}, { ...BASE_ENV, E2E_MODEL: 'openai/gpt-5.4-mini', AI_GATEWAY_API_KEY: 'x' });
    expect(config.agent.model).toBeUndefined();
  });

  it('rejects a model string with the constructor to write instead, so no gateway is implied', () => {
    expect(() => resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' } } } as never)).toThrow(
      /agents\.default\.model must be an AI SDK model instance, not the string "openai\/gpt-5\.4-mini": import a provider and construct the model, e\.g\. gateway\("openai\/gpt-5\.4-mini"\) from 'ai' or openrouter\("openai\/gpt-5\.4-mini"\) from '@openrouter\/ai-sdk-provider'/,
    );
    expect(() => resolve({ agents: { default: { model: { provider: 'openai', id: 'gpt-5.4-mini' } } } } as never)).toThrow(
      /agents\.default\.model must be an AI SDK model instance, e\.g\. gateway\('openai\/gpt-5\.6-luna'\) from 'ai'/,
    );
    expect(() => resolve({ agents: { ux: { model: 42 } } } as never)).toThrow(/agents\.ux\.model must be an AI SDK model instance/);
  });
});

describe('resource limits', () => {
  it('applies documented defaults and mirrors observation bytes from agent config', () => {
    const config = resolve({ agents: { default: { maxObservationBytes: 4_096 } } });
    expect(config.limits.maxObservationBytes).toBe(4_096);
    expect(config.limits.maxLedgerBytes).toBe(8_192);
    expect(config.limits.maxAgentContextBytes).toBe(16_384);
    expect(config.limits.maxEventsPerStep).toBe(1_000);
    expect(config.limits.maxModelTokensPerCall).toBe(64_000);
  });

  it('accepts overrides inside the hard ceilings and rejects the rest', () => {
    expect(resolve({ limits: { maxLedgerBytes: 65_536 } }).limits.maxLedgerBytes).toBe(65_536);
    expect(() => resolve({ limits: { maxLedgerBytes: 65_537 } })).toThrow(/maxLedgerBytes/);
    expect(() => resolve({ limits: { maxLedgerBytes: 1_023 } })).toThrow(/maxLedgerBytes/);
    expect(() => resolve({ limits: { maxModelTokensPerCall: 0 } })).toThrow(
      /maxModelTokensPerCall/,
    );
    expect(() => resolve({ limits: { unknown: 1 } } as never)).toThrow(/unknown limits key/);
  });

  it('rejects retired limits keys instead of silently ignoring them', () => {
    // These keys were validated-but-unenforced; a limit that exists must bind.
    expect(() => resolve({ limits: { maxEstimatedCostUsd: 0.5 } } as never)).toThrow(
      /unknown limits key/,
    );
    expect(() => resolve({ limits: { maxReportBytes: 1_024 } } as never)).toThrow(
      /unknown limits key/,
    );
  });
});

describe('model error classification', () => {
  it('separates an aborted attempt from an elapsed step budget', async () => {
    // A slow provider is a test timeout (exit 1); only an aborted attempt is a
    // runner cancellation (exit 3). Verified through the public adapter.
    const { createModelAdapter } = await import('../../src/agent/model/sdk.ts');
    const model = createGateway({ apiKey: 'x', baseURL: 'https://127.0.0.1:1/v1' }).languageModel('openai/unreachable');
    const adapter = createModelAdapter({ provider: model.provider, id: model.modelId, model });

    const aborted = new AbortController();
    aborted.abort();
    const call = {
      system: 's',
      prompt: 'p',
      schemaName: 'agent-judgment-2',
      schema: undefined,
      validate: (value: unknown) => ({ ok: true as const, value }),
      maxOutputTokens: 16,
      maxInputTokens: 64_000,
      timeoutMs: 50,
      signal: aborted.signal,
    };

    await expect(adapter.generate(call)).rejects.toMatchObject({ code: 'CANCELLED' });

    const live = new AbortController();
    await expect(
      adapter.generate({ ...call, signal: live.signal, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('does not retry a provider failure the provider called permanent', async () => {
    const failing = scriptedFailure({ statusCode: 400, isRetryable: false });
    const adapter = await instanceAdapter(failing.model);

    await expect(adapter.generate(modelCall())).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: expect.stringContaining('provider said no'),
    });
    expect(failing.attempts()).toBe(1);
  });

  it('retries a retryable provider failure and reports the underlying cause', async () => {
    // The retry chain is wrapped by the SDK once exhausted; the surfaced error
    // must still name the provider failure rather than the wrapper.
    const failing = scriptedFailure({ statusCode: 503, isRetryable: true });
    const adapter = await instanceAdapter(failing.model);
    vi.useFakeTimers();
    try {
      const generated = adapter.generate(modelCall());
      const assertion = expect(generated).rejects.toMatchObject({
        code: 'MODEL_PROVIDER_FAILED',
        message: expect.stringContaining('provider said no'),
      });
      await vi.advanceTimersByTimeAsync(TRANSPORT_BACKOFF_BUDGET_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(failing.attempts()).toBe(TRANSPORT_ATTEMPTS);
  });
});

/** One first call plus `TRANSPORT_RETRIES` retries in `src/agent/model/sdk.ts`. */
const TRANSPORT_ATTEMPTS = 6;

/** Exceeds the SDK's 2s-doubling backoff across every retry of one call. */
const TRANSPORT_BACKOFF_BUDGET_MS = 120_000;

/** Builds the adapter for a caller-supplied AI SDK model instance. */
async function instanceAdapter(model: unknown) {
  const { createModelAdapter } = await import('../../src/agent/model/sdk.ts');
  return createModelAdapter({
    provider: 'scripted',
    id: 'always-fails',
    model: model as never,
  });
}

/** A model instance that always fails one way, counting the attempts made. */
function scriptedFailure(options: { statusCode: number; isRetryable: boolean }) {
  let attempts = 0;
  return {
    attempts: () => attempts,
    model: {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'always-fails',
      supportedUrls: {},
      doGenerate: () => {
        attempts += 1;
        return Promise.reject(
          new APICallError({
            message: 'provider said no',
            url: 'https://scripted.invalid',
            requestBodyValues: {},
            statusCode: options.statusCode,
            isRetryable: options.isRetryable,
          }),
        );
      },
      doStream: () => Promise.reject(new Error('not called')),
    },
  };
}

/** A minimal hand-rolled step executor; each call constructs a fresh one. */
function brain() {
  return {
    name: 'custom-brain',
    version: '1',
    runStep: () => Promise.reject(new Error('not called')),
  };
}

/** The minimal model call used by the error-classification tests. */
function modelCall() {
  return {
    system: 's',
    prompt: 'p',
    schemaName: 'agent-judgment-2',
    schema: undefined,
    validate: (value: unknown) => ({ ok: true as const, value }),
    maxOutputTokens: 16,
    maxInputTokens: 64_000,
    timeoutMs: 600_000,
    signal: new AbortController().signal,
  };
}

describe('named agents', () => {
  const named = (name: string) => ({ name, async runStep() { return { status: 'passed' as const, summary: 'ok' }; } });

  it('resolves every named agent and runs with default unless --agent picks another', () => {
    const agents = () => ({
      default: { model: fakeModel('gateway', 'openai/gpt-5.4-mini') },
      ux: { model: fakeModel('gateway', 'google/gemini-3.6-flash'), context: 'Review the UX.' },
    });
    const config = resolve({ agents: agents() });
    expect([...config.agents.keys()]).toEqual(['default', 'ux']);
    expect(config.agentNames).toEqual(['default']);
    expect(config.agent.model).toMatchObject({ provider: 'gateway', id: 'openai/gpt-5.4-mini' });
    const picked = resolve({ agents: agents() }, BASE_ENV, { agents: ['ux'] });
    expect(picked.agentNames).toEqual(['ux']);
    expect(picked.agent.model).toMatchObject({ provider: 'gateway', id: 'google/gemini-3.6-flash' });
    expect(picked.agent.context).toBe('Review the UX.');
    // The limits carry the largest observation budget any agent may use, whichever runs.
    const uneven = resolve({ agents: { default: { maxObservationBytes: 4_096 }, ux: { maxObservationBytes: 65_536 } } });
    expect(uneven.limits.maxObservationBytes).toBe(65_536);
    expect(resolve({ agents: { default: { maxObservationBytes: 4_096 }, ux: { maxObservationBytes: 65_536 } } }, BASE_ENV, { agents: ['ux'] }).limits.maxObservationBytes).toBe(65_536);
  });

  it('always has a default agent, the built-in one without a model, even when only others are named', () => {
    const config = resolve({ agents: { ux: named('ux-brain') } });
    expect(config.agentNames).toEqual(['default']);
    expect(config.agent.executor).toBeUndefined();
    expect(config.agent.model).toBeUndefined();
    expect(config.agents.get('ux')?.executor?.name).toBe('ux-brain');
  });

  it('names the agent in every diagnostic', () => {
    expect(() => resolve({ agents: { ux: { maxSteps: 'many' } } } as never)).toThrow(/agents\.ux\.maxSteps/);
    expect(() => resolve({ agents: { ux: { retries: 1 } } } as never)).toThrow(/unknown agents\.ux key/);
    expect(() => resolve({ agents: { ux: 'gpt' } } as never)).toThrow(/agents\.ux must be an options object or the agent itself/);
  });

  it('rejects an unknown --agent before anything starts, naming the configured ones', () => {
    expect(() => resolve({ agents: { default: {}, ux: {} } }, BASE_ENV, { agents: ['uxx'] })).toThrow(
      /unknown agent "uxx"; configured: default, ux; did you mean "ux"\?/,
    );
  });

  it('rejects the removed agent key with the replacement, bad names, and a non-object agents', () => {
    expect(() => resolve({ agent: { model: fakeModel('openai', 'gpt-5.4-mini') } } as never)).toThrow(/agents: \{ default: <what agent held> \}/);
    expect(() => resolve({ agents: { 'u x': {} } })).toThrow(/invalid agent name "u x"/);
    expect(() => resolve({ agents: [] } as never)).toThrow(/agents must be an object of agents by name/);
    expect(() => resolve({ agents: named('x') } as never)).toThrow(/agents must be an object of agents by name/);
  });

  it('digests every named agent, so changing one changes the digest and a live model is reduced to its identity', () => {
    const base = resolve({ agents: { default: { model: fakeModel('openai', 'gpt-5.4-mini') }, ux: { context: 'a' } } });
    const changed = resolve({ agents: { default: { model: fakeModel('openai', 'gpt-5.4-mini') }, ux: { context: 'b' } } });
    expect(changed.configDigest).not.toBe(base.configDigest);
    const instance = (modelId: string) => ({ specificationVersion: 'v4', provider: 'openai', modelId, doGenerate: () => undefined }) as never;
    const first = resolve({ agents: { ux: { model: instance('gpt-5.4-mini') } } });
    const again = resolve({ agents: { ux: { model: instance('gpt-5.4-mini') } } });
    expect(again.configDigest).toBe(first.configDigest);
  });
});
