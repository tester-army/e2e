import { describe, expect, it } from 'vitest';
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

function contentFilterModel(text = '') {
  let attempts = 0;
  return {
    attempts: () => attempts,
    model: {
      specificationVersion: 'v4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5.5',
      supportedUrls: {},
      doGenerate: () => {
        attempts += 1;
        return Promise.resolve({
          content: text === '' ? [] : [{ type: 'text', text }],
          finishReason: { unified: 'content-filter', raw: 'refusal' },
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

function judgmentCall(structured: boolean) {
  return {
    system: 'system prompt',
    prompt: 'extract target token',
    schemaName: 'agent-extract-2',
    schema: structured
      ? { type: 'object' as const, properties: { found: { type: 'boolean' as const } }, required: ['found'] }
      : undefined,
    validate: (value: unknown) => ({ ok: true as const, value }),
    maxOutputTokens: 64,
    maxInputTokens: 64_000,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  };
}

describe('model refusal', () => {
  it.each([true, false])('fails a refused call as MODEL_REFUSED (structured: %s)', async (structured) => {
    const refusal = contentFilterModel();
    const adapter = createModelAdapter({ provider: 'anthropic', id: 'claude-sonnet-5.5', model: refusal.model as never });

    await expect(adapter.generate(judgmentCall(structured))).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      category: 'test',
      message: 'the model anthropic/claude-sonnet-5.5 refused the request (refusal)',
    });
    expect(refusal.attempts()).toBe(1);
  });

  it('keeps a usable answer that finished with content-filter', async () => {
    const refusal = contentFilterModel('{"found":true}');
    const adapter = createModelAdapter({ provider: 'anthropic', id: 'claude-sonnet-5.5', model: refusal.model as never });

    await expect(adapter.generate(judgmentCall(true))).resolves.toMatchObject({ value: { found: true } });
  });

  it('fails agent.act as MODEL_REFUSED', async () => {
    const refusal = contentFilterModel();
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
      attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal, memory: new Map() },
      artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
      priorSteps: () => steps.completed(),
      agentContext: undefined,
      saveSession: undefined,
      models: new WorkerModels(() => {}),
    });

    await expect(fixtures.agent.act('probe internal details')).rejects.toMatchObject({ code: 'MODEL_REFUSED' });
    expect(refusal.attempts()).toBe(1);
    expect(steps.all().at(-1)).toMatchObject({ api: 'agent.act', status: 'failed', error: { code: 'MODEL_REFUSED' } });
  });
});
