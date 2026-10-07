import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import { snapshot } from '../helpers/snapshot.ts';

function scriptedRefusal(options: { modelId?: string; provider?: string; rawFinishReason?: string } = {}) {
  let attempts = 0;
  return {
    attempts: () => attempts,
    model: {
      specificationVersion: 'v4',
      provider: options.provider ?? 'anthropic',
      modelId: options.modelId ?? 'claude-sonnet-5.5',
      supportedUrls: {},
      doGenerate: () => {
        attempts += 1;
        return Promise.resolve({
          content: [],
          finishReason: { unified: 'content-filter', raw: options.rawFinishReason ?? 'refusal' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        });
      },
      doStream: () => Promise.reject(new Error('not called')),
    },
  };
}

describe('model refusal classification', () => {
  it('classifies a structured model refusal as MODEL_REFUSED naming the step, model, and raw reason', async () => {
    const refusal = scriptedRefusal({ provider: 'anthropic', modelId: 'claude-sonnet-5.5', rawFinishReason: 'refusal' });
    const adapter = createModelAdapter({
      provider: refusal.model.provider,
      id: refusal.model.modelId,
      model: refusal.model as never,
    });

    const call = {
      step: 'agent.extract',
      system: 'extract system prompt',
      prompt: 'extract target token',
      schemaName: 'agent-extract-2',
      schema: {
        type: 'object' as const,
        properties: { found: { type: 'boolean' as const } },
        required: ['found'],
      },
      validate: (value: unknown) => ({ ok: true as const, value }),
      maxOutputTokens: 64,
      maxInputTokens: 64_000,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };

    await expect(adapter.generate(call)).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      category: 'test',
      retryable: false,
      message: 'agent.extract: the model anthropic/claude-sonnet-5.5 refused the request (refusal)',
    });
    expect(refusal.attempts()).toBe(1);
  });

  it('classifies an unstructured text model refusal as MODEL_REFUSED', async () => {
    const refusal = scriptedRefusal({ provider: 'anthropic', modelId: 'claude-sonnet-5.5', rawFinishReason: 'content_filter' });
    const adapter = createModelAdapter({
      provider: refusal.model.provider,
      id: refusal.model.modelId,
      model: refusal.model as never,
    });

    const call = {
      step: 'agent.extract',
      system: 'system prompt',
      prompt: 'plain text prompt',
      schemaName: 'agent-extract-2',
      schema: undefined,
      validate: (value: unknown) => ({ ok: true as const, value }),
      maxOutputTokens: 64,
      maxInputTokens: 64_000,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };

    await expect(adapter.generate(call)).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      category: 'test',
      retryable: false,
      message: 'agent.extract: the model anthropic/claude-sonnet-5.5 refused the request (content_filter)',
    });
    expect(refusal.attempts()).toBe(1);
  });

  it('fails agent.extract as MODEL_REFUSED when the model refuses the planning call', async () => {
    const refusal = scriptedRefusal({ provider: 'anthropic', modelId: 'claude-sonnet-5.5', rawFinishReason: 'refusal' });
    const engine = defineEngine({
      name: 'fake',
      version: '1',
      spiVersion: 1,
      observe: async () => snapshot([{ ref: { id: 'root', revision: '1' }, role: 'document', text: 'page content' }]),
    });
    const config = resolveConfig(
      {
        targets: [{ name: 'fake', platform: 'custom', engine }],
        cache: 'off',
        agents: { default: { model: refusal.model as never } },
      },
      { projectRoot: process.cwd(), env: {} },
    );
    const signal = new AbortController().signal;
    const steps = new StepRecorder('attempt');
    const { fixtures } = createFixtures({
      config,
      target: config.targets[0]!,
      session: createEngineSession({ engine, targetName: 'fake' }),
      steps,
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
      artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
      priorSteps: () => steps.completed(),
      agentContext: undefined,
      saveSession: undefined,
      models: new WorkerModels(() => {}),
    });

    await expect(
      fixtures.agent.extract('extract sensitive booking token', {
        schema: z.object({ token: z.string() }),
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      category: 'test',
      retryable: false,
      message: 'agent.extract: the model anthropic/claude-sonnet-5.5 refused the request (refusal)',
    });
    // extract allows one repair call. A refusal must not spend it.
    expect(refusal.attempts()).toBe(1);

    expect(steps.all().at(-1)).toMatchObject({
      api: 'agent.extract',
      status: 'failed',
      error: { code: 'MODEL_REFUSED' },
    });
  });

  it('fails agent.act as MODEL_REFUSED when the model refuses the action call', async () => {
    const refusal = scriptedRefusal({ provider: 'anthropic', modelId: 'claude-sonnet-5.5', rawFinishReason: 'refusal' });
    const engine = defineEngine({
      name: 'fake',
      version: '1',
      spiVersion: 1,
      observe: async () => snapshot([{ ref: { id: 'root', revision: '1' }, role: 'document', text: 'page content' }]),
    });
    const config = resolveConfig(
      {
        targets: [{ name: 'fake', platform: 'custom', engine }],
        cache: 'off',
        agents: { default: { model: refusal.model as never } },
      },
      { projectRoot: process.cwd(), env: {} },
    );
    const signal = new AbortController().signal;
    const steps = new StepRecorder('attempt');
    const { fixtures } = createFixtures({
      config,
      target: config.targets[0]!,
      session: createEngineSession({ engine, targetName: 'fake' }),
      steps,
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
      artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
      priorSteps: () => steps.completed(),
      agentContext: undefined,
      saveSession: undefined,
      models: new WorkerModels(() => {}),
    });

    await expect(fixtures.agent.act('probe internal details')).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      category: 'test',
      retryable: false,
      message: expect.stringMatching(/^agent\.act: the model anthropic\/claude-sonnet-5\.5 refused the request \((?:refusal|content-filter)\)$/),
    });
    expect(refusal.attempts()).toBe(1);

    expect(steps.all().at(-1)).toMatchObject({
      api: 'agent.act',
      status: 'failed',
      error: { code: 'MODEL_REFUSED' },
    });
  });

  it('classifies non-refusal empty output as MODEL_OUTPUT_INVALID rather than MODEL_PROVIDER_FAILED', async () => {
    const emptyModel = {
      specificationVersion: 'v4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5.5',
      supportedUrls: {},
      doGenerate: () => Promise.resolve({
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error('not called')),
    };
    const adapter = createModelAdapter({
      provider: emptyModel.provider,
      id: emptyModel.modelId,
      model: emptyModel as never,
    });

    const call = {
      step: 'agent.extract',
      system: 'extract system prompt',
      prompt: 'extract target token',
      schemaName: 'agent-extract-2',
      schema: {
        type: 'object' as const,
        properties: { found: { type: 'boolean' as const } },
        required: ['found'],
      },
      validate: (value: unknown) => ({ ok: true as const, value }),
      maxOutputTokens: 64,
      maxInputTokens: 64_000,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };

    await expect(adapter.generate(call)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
    });
  });
});
