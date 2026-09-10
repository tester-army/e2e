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

/** A screen whose text is far longer than the overflow clip, as a dense page is. */
const bigScreen = () =>
  defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => ({
      nodes: Array.from({ length: 600 }, (_, i) => ({ ref: { id: `n${String(i)}`, revision: '' }, role: 'text', name: `row ${String(i)} ${'x'.repeat(40)}` })),
    }),
  });

const OVERFLOW = 'prompt is too long: 300000 tokens > 200000 maximum';

/** A read-only project tool, so the loop has a first turn to spend before the refusal. */
const look = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });

describe('tool loop context overflow', () => {
  it('shrinks the history and retries once when the provider refuses the request as too large', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'look', input: {} }];
      if (turn === 2) throw new Error(OVERFLOW);
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the rows' } }];
    });
    const executor = createAgent({ tools: { look } });
    const { fixtures, steps } = runtime(bigScreen(), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(3);
    // The second request carried the whole opening screen; the retried request
    // carries its head and a notice, and the tool result it follows is unchanged.
    expect(loopCalls[1]!.prompt.length).toBeGreaterThan(16_384);
    expect(loopCalls[2]!.prompt.length).toBeLessThan(16_384 + 200);
    expect(loopCalls[2]!.prompt).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[2]!.lastToolResult).toBe(loopCalls[1]!.lastToolResult);
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    // The refused request never answered, so it is not a model call the step paid for.
    expect(step.metrics?.modelCalls).toBe(2);
  });

  it('reports CONTEXT_OVERFLOW when the shrunk request is refused again', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'look', input: {} }];
      throw new Error(OVERFLOW);
    });
    const executor = createAgent({ tools: { look } });
    const { fixtures } = runtime(bigScreen(), { agents: { default: { executor, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({
      code: 'CONTEXT_OVERFLOW',
      message: expect.stringContaining('again after the history was shrunk once'),
    });
    expect(loopCalls).toHaveLength(3);
  });

  it('does not resend a request that shrinking would not change', async () => {
    const model = installFakeLoopModel(() => {
      throw new Error(OVERFLOW);
    });
    const { fixtures } = runtime(engine(), { agents: { default: { executor: createAgent(), model } } });

    await expect(fixtures.agent.act('do the thing')).rejects.toMatchObject({
      code: 'CONTEXT_OVERFLOW',
      message: expect.stringContaining('had nothing left to shrink'),
    });
    // The opening request has no superseded screen and no long text: one
    // refusal is the verdict, not two.
    expect(loopCalls).toHaveLength(1);
  });

  it('leaves other provider failures to the ordinary error translation', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'look', input: {} }];
      throw new Error('Rate limit reached for requests');
    });
    const executor = createAgent({ tools: { look } });
    const { fixtures } = runtime(engine(), { agents: { default: { executor, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(loopCalls).toHaveLength(2);
  });
});
