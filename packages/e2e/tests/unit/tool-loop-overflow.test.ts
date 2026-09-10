import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../../src/agent/default-agent.ts';
import { defineTool } from '../../src/agent/tool.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(engine: EngineHandle, overrides: E2EConfig = {}) {
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const fixtures = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

const engine = () => defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }) });

const OVERFLOW = 'prompt is too long: 300000 tokens > 200000 maximum';

/** A read-only project tool whose output is far longer than the overflow clip. */
const bigTool = defineTool(
  { inputSchema: z.object({}), execute: async () => Array.from({ length: 800 }, (_, i) => `row ${String(i)} ${'x'.repeat(40)}`).join('\n') },
  { mutates: false },
);

describe('tool loop context overflow', () => {
  it('shrinks the history and retries once when the provider refuses the request as too large', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'big', input: {} }];
      if (turn === 2) throw new Error(OVERFLOW);
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the rows' } }];
    });
    const executor = createAgent({ tools: { big: bigTool } });
    const { fixtures, steps } = runtime(engine(), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(3);
    // The second request carried the whole tool output; the retried request
    // carries its head and a notice, and nothing else about the step changed.
    expect(loopCalls[1]!.lastToolResult.length).toBeGreaterThan(16_384);
    expect(loopCalls[2]!.lastToolResult.length).toBeLessThan(16_384 + 200);
    expect(loopCalls[2]!.lastToolResult).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[2]!.prompt).toBe(loopCalls[1]!.prompt);
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    // The refused request never answered, so it is not a model call the step paid for.
    expect(step.metrics?.modelCalls).toBe(2);
  });

  it('reports CONTEXT_OVERFLOW when the shrunk request is refused again', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'big', input: {} }];
      throw new Error(OVERFLOW);
    });
    const executor = createAgent({ tools: { big: bigTool } });
    const { fixtures } = runtime(engine(), { agents: { default: { executor, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({
      code: 'CONTEXT_OVERFLOW',
      message: expect.stringContaining('again after the history was shrunk once'),
    });
    expect(loopCalls).toHaveLength(3);
  });

  it('leaves other provider failures to the ordinary error translation', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'big', input: {} }];
      throw new Error('Rate limit reached for requests');
    });
    const executor = createAgent({ tools: { big: bigTool } });
    const { fixtures } = runtime(engine(), { agents: { default: { executor, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(loopCalls).toHaveLength(2);
  });
});
