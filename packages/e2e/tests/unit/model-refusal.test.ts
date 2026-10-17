/**
 * Model refusals surface as the typed `MODEL_REFUSED`, not as a provider
 * failure and not as invalid output — on the structured and text paths, and
 * whether the SDK finished the call or threw parsing the refused text. The
 * models are scripted AI SDK instances (see `tests/helpers/scripted-model.ts`),
 * so the tests run without a provider.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isAgentError } from '../../src/agent/error.ts';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';
import { ModelOutputInvalidError, type ModelCall } from '../../src/agent/model/adapter.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { Deadline } from '../../src/internal/time.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { EngineHandle } from '../../src/engine/index.ts';
import type { E2EConfig, ModelInstance } from '../../src/types.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

/**
 * A scripted model that refuses every request the way a provider's content
 * filter does: unified `content-filter`, raw `content_filter` on the wire.
 * `text` is the refused partial output, when the refusal carries any.
 */
function refusalModel(text?: string): { model: ModelInstance; calls: () => number } {
  let calls = 0;
  const content = text === undefined ? [] : [{ type: 'text' as const, text }];
  const model = createScriptedInstance('fake', 'scripted', async () => {
    calls += 1;
    return scriptedResult(content, 'content-filter', [], 'content_filter');
  });
  return { model, calls: () => calls };
}

function adapter(model: ModelInstance) {
  return createModelAdapter({ provider: model.provider, id: model.modelId, model });
}

function call(schemaName: string, schema: ModelCall<unknown>['schema']): ModelCall<unknown> {
  return {
    system: 's',
    prompt: 'p',
    schemaName,
    schema,
    validate: (value: unknown) => ({ ok: true as const, value }),
    maxOutputTokens: 16,
    maxInputTokens: 64_000,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the refused call to throw');
    },
    (cause: unknown) => cause,
  );
}

/** A real fixture graph with an in-memory engine, no runner process, no provider. */
function runtime(engine: EngineHandle, overrides: Partial<E2EConfig> = {}) {
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const registerArtifact = vi.fn(() => 'artifact');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: registerArtifact, link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

const emptyEngine = () =>
  defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });

describe('model refusal', () => {
  it('structured call: refusal is MODEL_REFUSED, not MODEL_PROVIDER_FAILED', async () => {
    const refused = refusalModel();
    const error = await refusalOf(adapter(refused.model).generate(call('agent-extract-2', { type: 'object' })));

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'configuration' });
    const message = (error as Error).message;
    expect(message).toContain("step 'agent-extract-2'");
    expect(message).toContain("model 'scripted'");
    // The raw provider reason, not the hardcoded unified one.
    expect(message).toContain("'content_filter'");
    expect(refused.calls()).toBe(1);
  });

  it('structured call: a refusal with partial text is MODEL_REFUSED, not MODEL_OUTPUT_INVALID', async () => {
    // The SDK parses inside `generateText`, so unparseable refused text throws
    // its object error before the adapter sees the finish reason.
    const refused = refusalModel('{"ok":');
    const error = await refusalOf(adapter(refused.model).generate(call('agent-extract-2', { type: 'object' })));

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'configuration' });
    expect((error as Error).message).toContain("'content-filter'");
    expect(refused.calls()).toBe(1);
  });

  it('text call: refusal is MODEL_REFUSED, not MODEL_OUTPUT_INVALID', async () => {
    const refused = refusalModel();
    const error = await refusalOf(adapter(refused.model).generate(call('agent-judgment-2', undefined)));

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'configuration' });
    expect((error as Error).message).toContain("'content_filter'");
  });

  it('structured call: unparseable non-refusal text keeps its rawText for the repair round', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () =>
      scriptedResult([{ type: 'text' as const, text: 'not json {' }], 'stop'),
    );
    const error = await refusalOf(adapter(model).generate(call('agent-extract-2', { type: 'object' })));

    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(error).toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
    expect((error as ModelOutputInvalidError).rawText).toBe('not json {');
  });

  it('agent.extract: a refused planning call fails MODEL_REFUSED without a repair round', async () => {
    const refused = refusalModel();
    const { fixtures, steps } = runtime(emptyEngine(), { agents: { default: { model: refused.model } } });

    await expect(
      fixtures.agent.extract('the customer phone number', { schema: z.object({ phone: z.string() }) }),
    ).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      message: expect.stringContaining("step 'agent-extract-2'"),
    });
    // A refusal is final: the invocation spends no repair round on it.
    expect(refused.calls()).toBe(1);
    expect(steps.all().at(-1)).toMatchObject({
      api: 'agent.extract',
      status: 'failed',
      error: { code: 'MODEL_REFUSED' },
    });
  });
});
