import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';

const ROOT = '/tmp/e2e-agent-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

function resolve(
  raw: Parameters<typeof resolveConfig>[0],
  env: NodeJS.ProcessEnv = BASE_ENV,
  cli?: CliOverrides,
) {
  return resolveConfig(raw, {
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
    expect(config.agent.maxObservationBytes).toBe(1_048_576);
    expect(config.agent.cache).toBe('read-write');
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.context).toBeUndefined();
  });

  it('defaults the cache to read-only in CI so untrusted runs cannot publish guidance', () => {
    const config = resolve({}, { ...BASE_ENV, CI: '1' } as NodeJS.ProcessEnv);
    expect(config.agent.cache).toBe('read-only');
  });

  it('forces the cache off for --no-agent-cache', () => {
    const config = resolve({ agent: { cache: 'read-write' } }, BASE_ENV, { agentCache: 'off' });
    expect(config.agent.cache).toBe('off');
  });

  it('bounds budgets to 1 through 100 and observation bytes to 1 KiB through 16 MiB', () => {
    expect(() => resolve({ agent: { maxSteps: 0 } })).toThrow(/maxSteps/);
    expect(() => resolve({ agent: { maxSteps: 101 } })).toThrow(/maxSteps/);
    expect(() => resolve({ agent: { maxModelCalls: 101 } })).toThrow(/maxModelCalls/);
    expect(() => resolve({ agent: { maxObservationBytes: 1023 } })).toThrow(/maxObservationBytes/);
    expect(() => resolve({ agent: { maxObservationBytes: 16_777_217 } })).toThrow(
      /maxObservationBytes/,
    );
  });

  it('rejects unknown agent keys and invalid cache modes', () => {
    expect(() => resolve({ agent: { retries: 2 } } as never)).toThrow(/unknown agent config key/);
    expect(() => resolve({ agent: { cache: 'always' } } as never)).toThrow(/invalid agent.cache/);
  });

  it('rejects context larger than the resolved agent-context limit', () => {
    expect(() => resolve({ agent: { context: 'x'.repeat(16_385) } })).toThrow(/agent.context is/);
    expect(resolve({ agent: { context: 'be terse' } }).agent.context).toBe('be terse');
    expect(() =>
      resolve({ agent: { context: 'x'.repeat(2_000) }, limits: { maxAgentContextBytes: 1_024 } }),
    ).toThrow(/agent.context is/);
  });
});

describe('model resolution', () => {
  it('splits "provider/model-id" at the first slash', () => {
    const config = resolve({ agent: { model: 'anthropic/claude-sonnet-4.5' } });
    expect(config.agent.model).toEqual({
      provider: 'anthropic',
      id: 'claude-sonnet-4.5',
      endpoint: undefined,
      apiKeyEnv: 'E2E_MODEL_API_KEY',
    });
  });

  it('keeps later slashes in the model ID', () => {
    expect(resolve({ agent: { model: 'vendor/family/model' } }).agent.model).toMatchObject({
      provider: 'vendor',
      id: 'family/model',
    });
  });

  it('falls back to E2E_MODEL when config omits a model', () => {
    const config = resolve({}, { ...BASE_ENV, E2E_MODEL: 'openai/gpt-5.4-mini' });
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini' });
  });

  it('prefers the config model over the environment', () => {
    const config = resolve({ agent: { model: 'google/gemini-2.5-flash' } }, {
      ...BASE_ENV,
      E2E_MODEL: 'openai/gpt-5.4-mini',
    });
    expect(config.agent.model).toMatchObject({ provider: 'google' });
  });

  it('rejects references without a provider or model ID', () => {
    expect(() => resolve({ agent: { model: 'gpt-5.4-mini' } })).toThrow(/provider\/model-id/);
    expect(() => resolve({ agent: { model: '/gpt' } })).toThrow(/provider\/model-id/);
    expect(() => resolve({ agent: { model: 'openai/' } })).toThrow(/provider\/model-id/);
    expect(() => resolve({}, { ...BASE_ENV, E2E_MODEL: 'nope' })).toThrow(/E2E_MODEL/);
  });

  it('accepts an explicit model object with a credential variable name', () => {
    const config = resolve({
      agent: { model: { provider: 'openai', id: 'gpt-5.4-mini', apiKeyEnv: 'MY_KEY' } },
    });
    expect(config.agent.model).toMatchObject({ apiKeyEnv: 'MY_KEY' });
  });

  it('never copies the credential value into resolved config', () => {
    const config = resolve({ agent: { model: 'openai/gpt-5.4-mini' } }, {
      ...BASE_ENV,
      E2E_MODEL_API_KEY: 'secret-value',
    });
    expect(JSON.stringify(config.agent)).not.toContain('secret-value');
  });

  it('requires HTTPS for nonlocal model endpoints', () => {
    expect(() =>
      resolve({ agent: { model: { provider: 'p', id: 'm', endpoint: 'http://example.test/v1' } } }),
    ).toThrow(/HTTPS/);
    expect(
      resolve({ agent: { model: { provider: 'p', id: 'm', endpoint: 'http://127.0.0.1:11434/v1' } } })
        .agent.model?.endpoint,
    ).toBe('http://127.0.0.1:11434/v1');
    expect(
      resolve({ agent: { model: { provider: 'p', id: 'm', endpoint: 'https://gw.example/v1' } } })
        .agent.model?.endpoint,
    ).toBe('https://gw.example/v1');
  });

  it('rejects malformed keys and endpoints', () => {
    expect(() =>
      resolve({ agent: { model: { provider: 'p', id: 'm', apiKeyEnv: '9-bad name' } } }),
    ).toThrow(/apiKeyEnv/);
    expect(() =>
      resolve({ agent: { model: { provider: 'p', id: 'm', endpoint: 'not-a-url' } } }),
    ).toThrow(/endpoint/);
    expect(() => resolve({ agent: { model: { provider: 'p' } } } as never)).toThrow(/model.id/);
    expect(() => resolve({ agent: { model: { provider: 'p', id: 'm', region: 'eu' } } } as never)).toThrow(
      /unknown agent.model key/,
    );
  });
});

describe('resource limits', () => {
  it('applies documented defaults and mirrors observation bytes from agent config', () => {
    const config = resolve({ agent: { maxObservationBytes: 4_096 } });
    expect(config.limits.maxObservationBytes).toBe(4_096);
    expect(config.limits.maxLedgerBytes).toBe(8_192);
    expect(config.limits.maxAgentContextBytes).toBe(16_384);
    expect(config.limits.maxCacheBytes).toBe(262_144);
    expect(config.limits.maxTerminalFieldBytes).toBe(8_192);
    expect(config.limits.maxModelCallsPerStep).toBe(25);
    expect(config.limits.maxEstimatedCostUsd).toBeUndefined();
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

  it('requires a finite positive cost ceiling', () => {
    expect(resolve({ limits: { maxEstimatedCostUsd: 0.5 } }).limits.maxEstimatedCostUsd).toBe(0.5);
    expect(() => resolve({ limits: { maxEstimatedCostUsd: 0 } })).toThrow(/maxEstimatedCostUsd/);
    expect(() =>
      resolve({ limits: { maxEstimatedCostUsd: Number.POSITIVE_INFINITY } }),
    ).toThrow(/maxEstimatedCostUsd/);
  });
});

describe('model error classification', () => {
  it('separates an aborted attempt from an elapsed step budget', async () => {
    // A slow provider is a test timeout (exit 1); only an aborted attempt is a
    // runner cancellation (exit 3). Verified through the public adapter.
    const { createGatewayAdapter } = await import('../../src/agent/model/gateway.ts');
    const model = {
      provider: 'openai',
      id: 'unreachable',
      endpoint: 'https://127.0.0.1:1/v1',
      apiKeyEnv: 'FAKE_KEY',
    } as const;
    const adapter = createGatewayAdapter(model, { FAKE_KEY: 'x' } as NodeJS.ProcessEnv);

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
});
