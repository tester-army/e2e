import { APICallError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import { createAgent } from '../../src/agent/default-agent.ts';
import type { SdkLanguageModel } from '../../src/config/agent.ts';

const ROOT = '/tmp/e2e-agent-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

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
    expect(config.agent.maxObservationBytes).toBe(262_144);
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.context).toBeUndefined();
    expect(config.agent.vision).toBe(false);
  });

  it('accepts every vision mode as a project default and rejects anything else', () => {
    expect(resolve({ agents: { default: { vision: true } } }).agent.vision).toBe(true);
    expect(resolve({ agents: { default: { vision: false } } }).agent.vision).toBe(false);
    expect(resolve({ agents: { default: { vision: 'fallback' } } }).agent.vision).toBe('fallback');
    expect(() => resolve({ agents: { default: { vision: 'yes' } } } as never)).toThrow(/agents\.default\.vision/);
    expect(() => resolve({ agents: { default: { vision: 1 } } } as never)).toThrow(/agents\.default\.vision/);
  });

  it('resolves a separate vision model, defaulting to none', () => {
    expect(resolve({}).agent.visionModel).toBeUndefined();
    const config = resolve({
      agents: { default: { model: 'fake/text', visionModel: 'fake/grounding' } },
    });
    expect(config.agent.model).toMatchObject({ provider: 'fake', id: 'text' });
    expect(config.agent.visionModel).toMatchObject({ provider: 'fake', id: 'grounding' });
  });

  it('overrides the vision model from E2E_VISION_MODEL', () => {
    const config = resolve({ agents: { default: { model: 'fake/text' } } }, {
      ...BASE_ENV,
      E2E_VISION_MODEL: 'fake/grounding',
    } as NodeJS.ProcessEnv);
    expect(config.agent.visionModel).toMatchObject({ provider: 'fake', id: 'grounding' });
  });

  it('names agent.visionModel in its own diagnostics', () => {
    expect(() => resolve({ agents: { default: { visionModel: 'nope' } } })).toThrow(/agents\.default\.visionModel/);
    expect(() => resolve({ agents: { default: { visionModel: { id: 'x' } } } } as never)).toThrow(
      /agents\.default\.visionModel\.provider/,
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

  it('still resolves the model from E2E_MODEL alongside a custom agent', () => {
    const config = resolve({ agents: { default: brain() } }, { ...BASE_ENV, E2E_MODEL: 'openai/gpt-5.4-mini' });
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini' });
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
  const instance = (modelId: string) =>
    ({
      specificationVersion: 'v2',
      provider: 'openai',
      modelId,
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('not called')),
      doStream: () => Promise.reject(new Error('not called')),
    }) as unknown as SdkLanguageModel;

  it('uses the model createAgent brought for the judgment tier too', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: createAgent({ model }) } });
    expect(config.agent.executor?.model).toBe(model);
    expect(config.agent.model).toMatchObject({ kind: 'instance', provider: 'openai', id: 'gpt-5.4-mini' });
  });

  it('prefers the executor model over E2E_MODEL', () => {
    const config = resolve(
      { agents: { default: createAgent({ model: instance('gpt-5.4-mini') }) } },
      { ...BASE_ENV, E2E_MODEL: 'anthropic/claude-sonnet-4.5' },
    );
    expect(config.agent.model).toMatchObject({ kind: 'instance', provider: 'openai', id: 'gpt-5.4-mini' });
  });

  it('accepts agent.model naming the same model as the executor', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: { executor: createAgent({ model }), model: 'openai/gpt-5.4-mini' } } });
    expect(config.agent.model).toMatchObject({ kind: 'instance', model });
  });

  it('rejects agent.model and an executor model that differ', () => {
    expect(() =>
      resolve({ agents: { default: { executor: createAgent({ model: instance('gpt-5.4-mini') }), model: 'openai/gpt-5.4' } } }),
    ).toThrow(/agents\.default\.model \(openai\/gpt-5\.4\) and the executor's own model \(openai\/gpt-5\.4-mini\) differ/);
    expect(() =>
      resolve({ agents: { default: { executor: createAgent({ model: instance('gpt-5.4-mini') }), model: instance('gpt-5.4') } } }),
    ).toThrow(/differ; configure the model in one place/);
  });

  it('leaves a custom executor without a model to E2E_MODEL', () => {
    expect(resolve({ agents: { default: brain() } }).agent.model).toBeUndefined();
  });
});

describe('model resolution', () => {
  it('splits "provider/model-id" at the first slash', () => {
    const config = resolve({ agents: { default: { model: 'anthropic/claude-sonnet-4.5' } } });
    expect(config.agent.model).toEqual({
      kind: 'gateway',
      provider: 'anthropic',
      id: 'claude-sonnet-4.5',
      endpoint: undefined,
      apiKeyEnv: 'E2E_MODEL_API_KEY',
      apiKeySource: undefined,
      apiKey: undefined,
    });
  });

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
    expect(config.agent.model).toMatchObject({
      kind: 'instance',
      provider: 'openai',
      id: 'gpt-5.4-mini',
    });
    // The live object never enters the digest, and the digest stays stable.
    const again = resolve({ agents: { default: { model: instance } } });
    expect(again.configDigest).toBe(config.configDigest);
  });

  it('keeps later slashes in the model ID', () => {
    expect(resolve({ agents: { default: { model: 'vendor/family/model' } } }).agent.model).toMatchObject({
      provider: 'vendor',
      id: 'family/model',
    });
  });

  it('falls back to E2E_MODEL when config omits a model', () => {
    const config = resolve({}, { ...BASE_ENV, E2E_MODEL: 'openai/gpt-5.4-mini' });
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini' });
  });

  it('prefers the config model over the environment', () => {
    const config = resolve({ agents: { default: { model: 'google/gemini-2.5-flash' } } }, {
      ...BASE_ENV,
      E2E_MODEL: 'openai/gpt-5.4-mini',
    });
    expect(config.agent.model).toMatchObject({ provider: 'google' });
  });

  it('rejects references without a provider or model ID', () => {
    expect(() => resolve({ agents: { default: { model: 'gpt-5.4-mini' } } })).toThrow(/provider\/model-id/);
    expect(() => resolve({ agents: { default: { model: '/gpt' } } })).toThrow(/provider\/model-id/);
    expect(() => resolve({ agents: { default: { model: 'openai/' } } })).toThrow(/provider\/model-id/);
    expect(() => resolve({}, { ...BASE_ENV, E2E_MODEL: 'nope' })).toThrow(/E2E_MODEL/);
  });

  it('accepts an explicit model object with a credential variable name', () => {
    const config = resolve({
      agents: { default: { model: { provider: 'openai', id: 'gpt-5.4-mini', apiKeyEnv: 'MY_KEY' } } },
    });
    expect(config.agent.model).toMatchObject({ apiKeyEnv: 'MY_KEY', apiKeySource: undefined });
    const withKey = resolve(
      { agents: { default: { model: { provider: 'openai', id: 'gpt-5.4-mini', apiKeyEnv: 'MY_KEY' } } } },
      { ...BASE_ENV, MY_KEY: 'custom', AI_GATEWAY_API_KEY: 'gateway-key' },
    );
    expect(withKey.agent.model).toMatchObject({ apiKeySource: 'MY_KEY', apiKey: 'custom' });
  });

  it('resolves the credential for the adapter without leaking it into the digest', () => {
    const config = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' } } }, {
      ...BASE_ENV,
      E2E_MODEL_API_KEY: 'secret-value',
    });
    expect(config.agent.model).toMatchObject({ apiKey: 'secret-value', apiKeySource: 'E2E_MODEL_API_KEY' });
    const withoutKey = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' } } });
    expect(withoutKey.agent.model).toMatchObject({ apiKey: undefined, apiKeySource: undefined });
    // Environment values never affect the digest.
    expect(withoutKey.configDigest).toBe(config.configDigest);
  });

  it('falls back to the gateway credential variable', () => {
    const config = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' } } }, {
      ...BASE_ENV,
      AI_GATEWAY_API_KEY: 'gateway-key',
    });
    expect(config.agent.model).toMatchObject({ apiKey: 'gateway-key', apiKeySource: 'AI_GATEWAY_API_KEY' });
    // An empty primary variable is absent, not a credential.
    const blank = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' } } }, {
      ...BASE_ENV,
      E2E_MODEL_API_KEY: '  ',
      AI_GATEWAY_API_KEY: 'gateway-key',
    });
    expect(blank.agent.model).toMatchObject({ apiKey: 'gateway-key', apiKeySource: 'AI_GATEWAY_API_KEY' });
  });

  it('requires HTTPS for nonlocal model endpoints', () => {
    expect(() =>
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', endpoint: 'http://example.test/v1' } } } }),
    ).toThrow(/HTTPS/);
    expect(
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', endpoint: 'http://127.0.0.1:11434/v1' } } } })
        .agent.model,
    ).toMatchObject({ endpoint: 'http://127.0.0.1:11434/v1' });
    expect(
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', endpoint: 'https://gw.example/v1' } } } })
        .agent.model,
    ).toMatchObject({ endpoint: 'https://gw.example/v1' });
  });

  it('reads the endpoint from E2E_MODEL_ENDPOINT when config sets none', () => {
    const env = {
      ...BASE_ENV,
      E2E_MODEL: 'openai/gpt-5.4-mini',
      E2E_MODEL_ENDPOINT: ' https://llm.example/v1 ',
    };
    expect(resolve({}, env).agent.model).toMatchObject({ endpoint: 'https://llm.example/v1' });
    expect(
      resolve({ agents: { default: { model: { provider: 'p', id: 'm' } } } }, env).agent.model,
    ).toMatchObject({ endpoint: 'https://llm.example/v1' });
  });

  it('prefers agent.model.endpoint over E2E_MODEL_ENDPOINT', () => {
    const env = { ...BASE_ENV, E2E_MODEL_ENDPOINT: 'https://env.example/v1' };
    expect(
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', endpoint: 'https://gw.example/v1' } } } }, env)
        .agent.model,
    ).toMatchObject({ endpoint: 'https://gw.example/v1' });
  });

  it('ignores a blank E2E_MODEL_ENDPOINT and validates a set one', () => {
    expect(
      resolve({ agents: { default: { model: 'p/m' } } }, { ...BASE_ENV, E2E_MODEL_ENDPOINT: '  ' }).agent.model,
    ).toMatchObject({ endpoint: undefined });
    expect(() =>
      resolve({ agents: { default: { model: 'p/m' } } }, { ...BASE_ENV, E2E_MODEL_ENDPOINT: 'http://example.test/v1' }),
    ).toThrow(/E2E_MODEL_ENDPOINT must use HTTPS/);
    expect(() =>
      resolve({ agents: { default: { model: 'p/m' } } }, { ...BASE_ENV, E2E_MODEL_ENDPOINT: 'not-a-url' }),
    ).toThrow(/invalid E2E_MODEL_ENDPOINT/);
  });

  it('rejects malformed keys and endpoints', () => {
    expect(() =>
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', apiKeyEnv: '9-bad name' } } } }),
    ).toThrow(/apiKeyEnv/);
    expect(() =>
      resolve({ agents: { default: { model: { provider: 'p', id: 'm', endpoint: 'not-a-url' } } } }),
    ).toThrow(/endpoint/);
    expect(() => resolve({ agents: { default: { model: { provider: 'p' } } } } as never)).toThrow(/model.id/);
    expect(() => resolve({ agents: { default: { model: { provider: 'p', id: 'm', region: 'eu' } } } } as never)).toThrow(
      /unknown agents\.default\.model key/,
    );
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
    const adapter = createModelAdapter({
      kind: 'gateway',
      provider: 'openai',
      id: 'unreachable',
      endpoint: 'https://127.0.0.1:1/v1',
      apiKeyEnv: 'FAKE_KEY',
      apiKeySource: 'FAKE_KEY',
      apiKey: 'x',
    });

    const aborted = new AbortController();
    aborted.abort();
    const call = {
      system: 's',
      prompt: 'p',
      schemaName: 'agent-judgment-1',
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
    kind: 'instance',
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
    schemaName: 'agent-judgment-1',
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
    const config = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' }, ux: { model: 'google/gemini-3.6-flash', context: 'Review the UX.' } } });
    expect([...config.agents.keys()]).toEqual(['default', 'ux']);
    expect(config.agentName).toBe('default');
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini' });
    const picked = resolve(
      { agents: { default: { model: 'openai/gpt-5.4-mini' }, ux: { model: 'google/gemini-3.6-flash', context: 'Review the UX.' } } },
      BASE_ENV,
      { agent: 'ux' },
    );
    expect(picked.agentName).toBe('ux');
    expect(picked.agent.model).toMatchObject({ provider: 'google', id: 'gemini-3.6-flash' });
    expect(picked.agent.context).toBe('Review the UX.');
    // The selection also decides the observation budget the limits carry.
    expect(picked.limits.maxObservationBytes).toBe(picked.agent.maxObservationBytes);
  });

  it('always has a default agent, the built-in one with E2E_MODEL, even when only others are named', () => {
    const config = resolve({ agents: { ux: named('ux-brain') } }, { ...BASE_ENV, E2E_MODEL: 'openai/gpt-5.4-mini' });
    expect(config.agentName).toBe('default');
    expect(config.agent.executor).toBeUndefined();
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini' });
    expect(config.agents.get('ux')?.executor?.name).toBe('ux-brain');
  });

  it('names the agent in every diagnostic', () => {
    expect(() => resolve({ agents: { ux: { vision: 'yes' } } } as never)).toThrow(/agents\.ux\.vision/);
    expect(() => resolve({ agents: { ux: { retries: 1 } } } as never)).toThrow(/unknown agents\.ux key/);
    expect(() => resolve({ agents: { ux: 'gpt' } } as never)).toThrow(/agents\.ux must be an options object or the agent itself/);
  });

  it('rejects an unknown --agent before anything starts, naming the configured ones', () => {
    expect(() => resolve({ agents: { default: {}, ux: {} } }, BASE_ENV, { agent: 'uxx' })).toThrow(
      /unknown agent "uxx"; configured: default, ux; did you mean "ux"\?/,
    );
  });

  it('rejects the removed agent key with the replacement, bad names, and a non-object agents', () => {
    expect(() => resolve({ agent: { model: 'openai/gpt-5.4-mini' } } as never)).toThrow(/agents: \{ default: <what agent held> \}/);
    expect(() => resolve({ agents: { 'u x': {} } })).toThrow(/invalid agent name "u x"/);
    expect(() => resolve({ agents: [] } as never)).toThrow(/agents must be an object of agents by name/);
    expect(() => resolve({ agents: named('x') } as never)).toThrow(/agents must be an object of agents by name/);
  });

  it('digests every named agent, so changing one changes the digest and a live model is reduced to its identity', () => {
    const base = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' }, ux: { context: 'a' } } });
    const changed = resolve({ agents: { default: { model: 'openai/gpt-5.4-mini' }, ux: { context: 'b' } } });
    expect(changed.configDigest).not.toBe(base.configDigest);
    const instance = (modelId: string) => ({ specificationVersion: 'v4', provider: 'openai', modelId, doGenerate: () => undefined }) as never;
    const first = resolve({ agents: { ux: { model: instance('gpt-5.4-mini') } } });
    const again = resolve({ agents: { ux: { model: instance('gpt-5.4-mini') } } });
    expect(again.configDigest).toBe(first.configDigest);
  });
});
