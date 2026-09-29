import { APICallError, createGateway } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import { z } from 'zod';
import { defineTool } from '../../src/agent/tool.ts';
import { createToolLoopExecutor } from '../../src/agent/tool-loop.ts';
import type { SdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import type { E2EConfig } from '../../src/types.ts';
import { HARNESS_TOOL_NAMES } from '../../src/agent/action-names.ts';
import { FINDING_TOOL_NAME } from '../../src/explore/executor.ts';
import { recordingTools } from '../../src/mcp/recording.ts';

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
  raw: Partial<E2EConfig>,
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
    expect(config.agent.judgmentTimeout).toBe(30_000);
    expect(config.agent.maxObservationBytes).toBe(262_144);
    expect(config.agent.maxInputTokens).toBe(64_000);
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.context).toBeUndefined();
    expect(config.agent.system).toBeUndefined();
    expect(config.agent.tools).toEqual({});
    expect(config.agent.executor).toBeUndefined();
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

  it('bounds budgets to 1 through 100, observation bytes to 1 KiB through 16 MiB, and input tokens to 1 through 1000000', () => {
    expect(() => resolve({ agents: { default: { maxSteps: 0 } } })).toThrow(/maxSteps/);
    expect(() => resolve({ agents: { default: { maxSteps: 101 } } })).toThrow(/maxSteps/);
    expect(() => resolve({ agents: { default: { maxModelCalls: 101 } } })).toThrow(/maxModelCalls/);
    expect(() => resolve({ agents: { default: { maxObservationBytes: 1023 } } })).toThrow(/maxObservationBytes/);
    expect(() => resolve({ agents: { default: { maxObservationBytes: 16_777_217 } } })).toThrow(
      /maxObservationBytes/,
    );
    expect(resolve({ agents: { default: { maxInputTokens: 200_000 } } }).agent.maxInputTokens).toBe(200_000);
    expect(() => resolve({ agents: { default: { maxInputTokens: 0 } } })).toThrow(
      'agents.default.maxInputTokens must be an integer from 1 through 1000000',
    );
    expect(() => resolve({ agents: { default: { maxInputTokens: 1_000_001 } } })).toThrow(/agents\.default\.maxInputTokens/);
  });

  it('owns the judgment budget: judgmentTimeout is per agent and independent of actionTimeout', () => {
    const config = resolve({ actionTimeout: 90_000, agents: { default: {}, slow: { judgmentTimeout: 120_000 } } });
    expect(config.agent.judgmentTimeout).toBe(30_000);
    expect(config.agents.get('slow')?.judgmentTimeout).toBe(120_000);
    expect(config.actionTimeout).toBe(90_000);
    expect(() => resolve({ agents: { default: { judgmentTimeout: 0 } } })).toThrow(
      /agents\.default\.judgmentTimeout must be a positive/,
    );
    expect(() => resolve({ agents: { default: { judgmentTimeout: 1.5 } } })).toThrow(/agents\.default\.judgmentTimeout/);
  });

  it('rejects unknown agent keys with the nearest one, including the removed cache mode', () => {
    expect(() => resolve({ agents: { default: { retries: 2 } } } as never)).toThrow(/unknown agents\.default key/);
    expect(() => resolve({ agents: { default: { cache: 'always' } } } as never)).toThrow(
      /unknown agents\.default key/,
    );
    expect(() => resolve({ agents: { default: { sytem: 'Be careful.' } } } as never)).toThrow(
      'unknown agents.default key "sytem"; did you mean "system"?',
    );
    expect(() => resolve({ agents: { ux: { maxInputToken: 1_000 } } } as never)).toThrow(
      'unknown agents.ux key "maxInputToken"; did you mean "maxInputTokens"?',
    );
  });

  it.each([
    ['timeout', 'agents.default.timeout was removed: use judgmentTimeout, the deadline of one assert, waitFor, or extract call'],
    ['maxTurns', 'agents.default.maxTurns was removed: use maxModelCalls, the model requests one agent call may make'],
    ['maxModelTokensPerCall', 'agents.default.maxModelTokensPerCall was removed: use maxInputTokens'],
  ])('rejects the removed agent key %s, naming its replacement', (key, message) => {
    expect(() => resolve({ agents: { default: { [key]: 30_000 } } } as never)).toThrow(message);
  });

  it('rejects context larger than the agent-context limit', () => {
    expect(() => resolve({ agents: { default: { context: 'x'.repeat(16_385) } } })).toThrow(
      'agents.default.context is 16385 bytes; the maximum is 16384',
    );
    expect(resolve({ agents: { default: { context: 'x'.repeat(16_384) } } }).agent.context).toHaveLength(16_384);
    expect(resolve({ agents: { default: { context: 'be terse' } } }).agent.context).toBe('be terse');
    expect(() => resolve({ agents: { default: { context: 5 } } } as never)).toThrow('agents.default.context must be a string');
  });
});

describe('the agents entry shape', () => {
  it('rejects a bare StepExecutor, pointing at { executor }', () => {
    expect(() => resolve({ agents: { default: brain() } } as never)).toThrow(
      'agents.default is a StepExecutor ("custom-brain"); an agents entry is an options object now, so pass it as agents.default: { executor, model, ... }',
    );
  });

  it('rejects maxTurns on createToolLoopExecutor, naming maxModelCalls', () => {
    expect(() => createToolLoopExecutor({ name: 'brain', tools: () => ({}), buildPrompt: () => 'go', maxTurns: 3 } as never)).toThrow(
      'createToolLoopExecutor({ maxTurns }) was removed: set maxModelCalls on the agents entry that runs the executor',
    );
  });

  it('rejects an entry that is not an options object', () => {
    expect(() => resolve({ agents: { ux: 'gpt' } } as never)).toThrow(/^agents\.ux must be an options object: agents\.ux: \{ model/);
    expect(() => resolve({ agents: { ux: [] } } as never)).toThrow(/agents\.ux must be an options object/);
  });

  it('gives every agent the built-in defaults, never another agent\'s values', () => {
    const tools = { lookup: readOnlyTool() };
    const config = resolve({
      agents: {
        default: { model: fakeModel('openai', 'gpt-5.4-mini'), system: 'Be careful.', context: 'Plans are tiers.', tools, maxSteps: 5, judgmentTimeout: 90_000, maxInputTokens: 10_000 },
        ux: {},
      },
    });
    const ux = config.agents.get('ux')!;
    expect(ux).toMatchObject({ model: undefined, judge: undefined, system: undefined, context: undefined, tools: {}, maxSteps: 25, judgmentTimeout: 30_000, maxInputTokens: 64_000 });
  });
});

describe('a custom executor', () => {
  it('keeps the options at defaults beside it', () => {
    const config = resolve({ agents: { default: { executor: brain() } } });
    expect(config.agent.executor).toMatchObject({ name: 'custom-brain' });
    expect(config.agent.model).toBeUndefined();
    expect(config.agent.maxSteps).toBe(25);
    expect(config.agent.tools).toEqual({});
  });

  it('digests a custom agent by name and version, deterministically', () => {
    const first = resolve({ agents: { default: { executor: brain() } } });
    const again = resolve({ agents: { default: { executor: brain() } } });
    expect(again.configDigest).toBe(first.configDigest);
    const renamed = resolve({ agents: { default: { executor: { ...brain(), name: 'other-brain' } } } });
    expect(renamed.configDigest).not.toBe(first.configDigest);
  });

  it('accepts the model, judge, context, and budgets alongside it', () => {
    const model = fakeModel('openai', 'gpt-5.4-mini');
    const judge = fakeModel('openai', 'gpt-5.4');
    const config = resolve({
      agents: { default: { executor: brain(), model, judge, context: 'Plans are tiers.', maxModelCalls: 40, judgmentTimeout: 60_000, maxInputTokens: 8_000 } },
    });
    expect(config.agent.executor?.name).toBe('custom-brain');
    expect(config.agent).toMatchObject({ context: 'Plans are tiers.', maxModelCalls: 40, judgmentTimeout: 60_000, maxInputTokens: 8_000 });
    expect(config.agent.model).toMatchObject({ model });
    expect(config.agent.judge).toMatchObject({ model: judge });
  });

  it('rejects system and tools, which belong to the built-in agent', () => {
    expect(() => resolve({ agents: { default: { executor: brain(), system: 'Be careful.' } } } as never)).toThrow(
      'agents.default.system is an option of the built-in agent, and agents.default.executor replaces it: a custom executor brings its own prompt; drop system or drop executor',
    );
    expect(() => resolve({ agents: { ux: { executor: brain(), tools: { lookup: readOnlyTool() } } } } as never)).toThrow(
      'agents.ux.tools is an option of the built-in agent, and agents.ux.executor replaces it: a custom executor brings its own tools; drop tools or drop executor',
    );
  });

  it('rejects an executor value that is not a StepExecutor', () => {
    expect(() => resolve({ agents: { default: { executor: { name: 'x' } } } } as never)).toThrow(
      /agents\.default\.executor must be a StepExecutor/,
    );
  });

  it('ignores a context member on the executor, string or not', () => {
    const model = fakeModel('openai', 'gpt-5.4-mini');
    const talkative = { name: 'custom', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }), context: 'not a prompt' };
    expect(resolve({ agents: { default: { executor: talkative, model } } }).agent.context).toBeUndefined();
    const stateful = { name: 'custom', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }), context: Promise.resolve(1) };
    expect(resolve({ agents: { default: { executor: stateful, model } } }).agent.context).toBeUndefined();
  });
});

describe('the built-in agent options', () => {
  it('keeps system and the defineTool tools', () => {
    const lookup = readOnlyTool();
    const config = resolve({ agents: { default: { system: 'Verify every total.', tools: { lookup } } } });
    expect(config.agent.system).toBe('Verify every total.');
    expect(config.agent.tools).toEqual({ lookup });
    expect(() => resolve({ agents: { default: { system: 5 } } } as never)).toThrow('agents.default.system must be a string');
  });

  it('rejects a tool defineTool did not build, a tools value that is not an object, and a reserved name', () => {
    const plain = { description: 'raw', inputSchema: z.object({}), execute: async () => 'x' };
    expect(() => resolve({ agents: { default: { tools: { raw: plain } } } } as never)).toThrow(
      'agents.default.tools.raw was not created with defineTool; undeclared semantics are not trusted',
    );
    expect(() => resolve({ agents: { default: { tools: [readOnlyTool()] } } } as never)).toThrow(
      'agents.default.tools must be an object of tools by name, each from defineTool',
    );
    for (const name of ['tap', 'observe', 'screenshot']) {
      expect(() => resolve({ agents: { ux: { tools: { [name]: readOnlyTool() } } } })).toThrow(
        `agents.ux.tools.${name}: the ${name} tool name is reserved for the agent's own tools`,
      );
    }
  });

  it('rejects the names of the tools the harness adds in an agent step, an e2e mcp session, and explore', () => {
    const where = { complete_step: 'every agent step', locate: 'an e2e mcp session', start_recording: 'an e2e mcp session', stop_recording: 'an e2e mcp session', report_finding: 'e2e explore' };
    for (const [name, surface] of Object.entries(where)) {
      expect(() => resolve({ agents: { ux: { tools: { [name]: readOnlyTool() } } } })).toThrow(
        `agents.ux.tools.${name}: the ${name} tool name is reserved for the tool the harness adds in ${surface}; rename it`,
      );
    }
    // The list is the tools those surfaces really add.
    const sessionTools = Object.keys({ locate: true, ...recordingTools({} as never) });
    expect([...HARNESS_TOOL_NAMES.keys()].toSorted()).toEqual(['complete_step', FINDING_TOOL_NAME, ...sessionTools].toSorted());
  });

  it('refuses a model instance used as the entry itself, naming the model', () => {
    const model = fakeModel('gateway', 'openai/gpt-6-luna-fast');
    expect(() => resolve({ agents: { default: model as never } })).toThrow(
      'agents.default is a model instance (gateway/openai/gpt-6-luna-fast); an agents entry is an options object, so write agents.default: { model: ... } with it',
    );
  });

  it('digests tools by name and live values by identity, so a recursive tool schema loads', () => {
    type Node = { name: string; readonly children: Node[] };
    const node: z.ZodType<Node> = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const tree = defineTool({ description: 'walks a tree', inputSchema: z.object({ root: node }), execute: async () => 'ok' }, { mutates: false });
    const circular: Record<string, unknown> = { writable: true, read: async () => undefined, write: async () => undefined };
    circular['self'] = circular;
    const config = resolve({ agents: { default: { tools: { tree } } }, cache: { store: circular as never } });
    expect(config.agent.tools).toEqual({ tree });
    const renamed = resolve({ agents: { default: { tools: { walk: tree } } }, cache: { store: circular as never } });
    expect(renamed.configDigest).not.toBe(config.configDigest);
  });
});

describe('one canonical model', () => {
  const instance = (modelId: string) => fakeModel('openai', modelId);

  it('uses the model a custom executor brought for the judgment tier too', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: { executor: { ...brain(), model } } } });
    expect(config.agent.model).toMatchObject({ provider: 'openai', id: 'gpt-5.4-mini', model });
    expect(config.agent.judge).toMatchObject({ model });
  });

  it('accepts the entry model naming the same model as the executor', () => {
    const model = instance('gpt-5.4-mini');
    const config = resolve({ agents: { default: { executor: { ...brain(), model }, model: instance('gpt-5.4-mini') } } });
    expect(config.agent.model).toMatchObject({ model });
  });

  it('rejects an entry model and an executor model that differ', () => {
    expect(() =>
      resolve({ agents: { default: { executor: { ...brain(), model: instance('gpt-5.4-mini') }, model: instance('gpt-5.4') } } }),
    ).toThrow(/agents\.default\.model \(openai\/gpt-5\.4\) and the executor's own model \(openai\/gpt-5\.4-mini\) differ; configure the model in one place/);
    expect(() =>
      resolve({ agents: { default: { executor: { ...brain(), model: instance('gpt-5.4-mini') }, model: fakeModel('gateway', 'openai/gpt-5.4-mini') } } }),
    ).toThrow(/differ; configure the model in one place/);
  });

  it('leaves a custom executor without a model unconfigured', () => {
    expect(resolve({ agents: { default: { executor: brain() } } }).agent.model).toBeUndefined();
  });
});

describe('judge model', () => {
  const instance = (id: string) => fakeModel('openai', id);

  it('is the model unless one is configured, so judgments always have one rule', () => {
    const model = instance('gpt-5.4-mini');
    expect(resolve({ agents: { default: { model } } }).agent.judge).toMatchObject({ model });
    expect(resolve({}).agent.judge).toBeUndefined();
  });

  it('resolves agent.judge apart from agent.model', () => {
    const judge = instance('gpt-5.4');
    const config = resolve({ agents: { default: { model: instance('gpt-5.4-mini'), judge } } });
    expect(config.agent.model).toMatchObject({ id: 'gpt-5.4-mini' });
    expect(config.agent.judge).toMatchObject({ provider: 'openai', id: 'gpt-5.4', model: judge });
  });

  it('uses the judge a custom executor brought', () => {
    const judge = instance('gpt-5.4');
    const config = resolve({ agents: { default: { executor: { ...brain(), model: instance('gpt-5.4-mini'), judge } } } });
    expect(config.agent.judge).toMatchObject({ id: 'gpt-5.4', model: judge });
  });

  it('rejects an entry judge and an executor judge that differ', () => {
    expect(() =>
      resolve({
        agents: {
          default: { executor: { ...brain(), model: instance('gpt-5.4-mini'), judge: instance('gpt-5.4') }, judge: instance('gpt-5.5') },
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
      /agents\.default\.model must be an AI SDK model instance, e\.g\. gateway\('openai\/gpt-6-luna-fast'\) from 'ai'/,
    );
    expect(() => resolve({ agents: { ux: { model: 42 } } } as never)).toThrow(/agents\.ux\.model must be an AI SDK model instance/);
  });
});

describe('run limits', () => {
  it('reports the internal limits and the defaults of the per-agent ones', () => {
    expect(resolve({}).limits).toEqual({
      maxAgentContextBytes: 16_384,
      maxLedgerBytes: 8_192,
      maxObservationBytes: 262_144,
      maxEventsPerStep: 1_000,
      maxModelTokensPerCall: 64_000,
    });
  });

  it('fills the per-agent limits with the largest any configured agent may use, whichever runs', () => {
    const agents = {
      default: { maxObservationBytes: 4_096, maxInputTokens: 200_000 },
      ux: { maxObservationBytes: 65_536, maxInputTokens: 8_000 },
    };
    for (const selected of [undefined, ['ux']]) {
      const config = resolve({ agents }, BASE_ENV, selected === undefined ? undefined : { agents: selected });
      expect(config.limits).toMatchObject({ maxObservationBytes: 65_536, maxModelTokensPerCall: 200_000, maxLedgerBytes: 8_192 });
    }
    // The implicit default agent counts too.
    expect(resolve({ agents: { ux: { maxInputTokens: 8_000 } } }).limits.maxModelTokensPerCall).toBe(64_000);
  });

  it('rejects the removed limits key, naming each replacement', () => {
    expect(() => resolve({ limits: { maxModelTokensPerCall: 1_000 } } as never)).toThrow(
      'limits was removed: set maxInputTokens on each agent (it was limits.maxModelTokensPerCall); the runner fixes maxAgentContextBytes, maxLedgerBytes, and maxEventsPerStep',
    );
    expect(() => resolve({ limits: {} } as never)).toThrow(/^limits was removed: /);
    expect(() => resolve({ agents: { default: { limits: {} } } } as never)).toThrow(
      'agents.default.limits was removed: set maxInputTokens on the agent; the runner fixes the other limits',
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

/** A read-only project tool that is never called. */
function readOnlyTool() {
  return defineTool({ description: 'looks something up', inputSchema: z.object({}), execute: async () => 'found' }, { mutates: false });
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
  });

  it('always has a default agent, the built-in one without a model, even when only others are named', () => {
    const config = resolve({ agents: { ux: { executor: named('ux-brain') } } });
    expect(config.agentNames).toEqual(['default']);
    expect(config.agent.executor).toBeUndefined();
    expect(config.agent.model).toBeUndefined();
    expect(config.agents.get('ux')?.executor?.name).toBe('ux-brain');
  });

  it('names the agent in every diagnostic', () => {
    expect(() => resolve({ agents: { ux: { maxSteps: 'many' } } } as never)).toThrow(/agents\.ux\.maxSteps/);
    expect(() => resolve({ agents: { ux: { retries: 1 } } } as never)).toThrow(/unknown agents\.ux key/);
    expect(() => resolve({ agents: { ux: 'gpt' } } as never)).toThrow(/agents\.ux must be an options object/);
  });

  it('rejects an unknown --agent before anything starts, naming the configured ones', () => {
    expect(() => resolve({ agents: { default: {}, ux: {} } }, BASE_ENV, { agents: ['uxx'] })).toThrow(
      /unknown agent "uxx"; configured: default, ux; did you mean "ux"\?/,
    );
  });

  it('rejects the removed agent key with the replacement, bad names, and a non-object agents', () => {
    expect(() => resolve({ agent: { model: fakeModel('openai', 'gpt-5.4-mini') } } as never)).toThrow(/agents: \{ default: <what agent held> \}/);
    expect(() => resolve({ agents: { 'u x': {} } })).toThrow(/invalid agent name "u x"/);
    // An agent's name is an artifact path segment, so `.` and `..` are out.
    expect(() => resolve({ agents: { '..': {} } })).toThrow('invalid agent name "..": names are ASCII letters, numbers, "_", "-", or ".", and cannot be only dots');
    expect(() => resolve({ agents: { '.': {} } })).toThrow(/invalid agent name "\."/);
    expect(resolve({ agents: { 'v1.2': {} } }).agents.has('v1.2')).toBe(true);
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
