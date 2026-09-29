import { generateText } from 'ai';
import * as ai from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withStallGuard } from '../../src/agent/model/stall.ts';
import { asSdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import { defineTool } from '../../src/agent/tool.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';
import { judgment } from '../helpers/fake-model.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

// The loop and the judgment adapter take the production bound; a test waits 50 ms for a stall, not 120 s.
vi.mock(import('../../src/agent/model/stall.ts'), async (importOriginal) => {
  const stall = await importOriginal();
  return { withStallGuard: (sdk, model, onStall, stallMs = 50) => stall.withStallGuard(sdk, model, onStall, stallMs) };
});

/** Settles only when `signal` aborts, as a request the provider never answers does. */
function never(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

describe('withStallGuard', () => {
  it('sends a request that got no response again, as a retryable provider error', async () => {
    let calls = 0;
    const model = createScriptedInstance('fake', 'stall', async (options: { abortSignal?: AbortSignal }) => {
      calls += 1;
      if (calls === 1) return never(options.abortSignal);
      return scriptedResult([{ type: 'text', text: 'answered' }], 'stop');
    });
    const stalls: number[] = [];
    const result = await generateText({
      model: withStallGuard(ai, asSdkLanguageModel(model), (ms) => stalls.push(ms), 50),
      prompt: 'hello',
      maxRetries: 1,
    });

    expect(result.text).toBe('answered');
    expect(calls).toBe(2);
    expect(stalls).toEqual([50]);
  });

  it("passes the caller's cancellation through as it was, not as a stall", async () => {
    const model = createScriptedInstance('fake', 'stall', async (options: { abortSignal?: AbortSignal }) => never(options.abortSignal));
    const stalls: number[] = [];
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(new Error('cancelled by the caller')), 20);

    await expect(
      generateText({ model: withStallGuard(ai, asSdkLanguageModel(model), (ms) => stalls.push(ms), 10_000), prompt: 'hello', abortSignal: cancel.signal }),
    ).rejects.toThrow('cancelled by the caller');
    expect(stalls).toEqual([]);
  });
});

const peek = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(overrides: Partial<E2EConfig>) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
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
  return { fixtures, steps };
}

describe('tool loop stall', () => {
  it('sends a stalled turn again and notes it on the turn before', async () => {
    let requests = 0;
    const model = createScriptedInstance('fake', 'stalls-once', async (options: { abortSignal?: AbortSignal }) => {
      requests += 1;
      if (requests === 1) return scriptedResult([{ type: 'tool-call', toolCallId: 'c1', toolName: 'peek', input: '{}' }], 'tool-calls');
      if (requests === 2) return never(options.abortSignal);
      return scriptedResult(
        [{ type: 'tool-call', toolCallId: 'c2', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'done' }) }],
        'tool-calls',
      );
    });
    const { fixtures, steps } = runtime({ agents: { default: { tools: { peek }, model } } });

    await fixtures.agent.act('look around');

    expect(requests).toBe(3);
    const turns = steps.all()[0]!.turns!;
    expect(turns.map((turn) => turn.calls)).toEqual([['peek({})'], ['complete_step({"status":"passed","summary":"done"})']]);
    expect(turns[0]!.outcome.split('\n').at(-1)).toBe('[loop] turn 2 got no response in 0.05s: sending it again');
  });
});

describe('judgment stall', () => {
  it('sends a stalled judgment again and keeps its verdict', async () => {
    let requests = 0;
    const model = createScriptedInstance('fake', 'stalls-once', async (options: { abortSignal?: AbortSignal }) => {
      requests += 1;
      if (requests === 1) return never(options.abortSignal);
      return scriptedResult([{ type: 'text', text: JSON.stringify(judgment(true, 'the screen is empty')) }], 'stop');
    });
    const { fixtures, steps } = runtime({ agents: { default: { model } } });

    await fixtures.agent.assert('the screen is empty');

    expect(requests).toBe(2);
    expect(steps.all()[0]).toMatchObject({ api: 'agent.assert', status: 'passed' });
  });
});

describe('tool loop step timeout', () => {
  it('keeps the turns that ran when the clock ends the step during a model call', async () => {
    let turns = 0;
    const model = createScriptedInstance('fake', 'hangs', async (options: { abortSignal?: AbortSignal }) => {
      turns += 1;
      if (turns === 1) return scriptedResult([{ type: 'tool-call', toolCallId: 'c1', toolName: 'peek', input: '{}' }], 'tool-calls');
      return never(options.abortSignal);
    });
    const { fixtures, steps } = runtime({ agents: { default: { tools: { peek }, model } } });

    await expect(fixtures.agent.act('look around', { timeout: 300 })).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });

    const step = steps.all()[0]!;
    expect(step.turns?.map((turn) => turn.calls)).toEqual([['peek({})']]);
  });

  it('reports a loop note on a turn whole, after the clipped tool results', async () => {
    const read = defineTool({ inputSchema: z.object({}), execute: async () => 'x'.repeat(2_000) }, { mutates: false });
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'read', input: {} }];
      throw new Error('prompt is too long: 300000 tokens > 200000 maximum');
    });
    const { fixtures, steps } = runtime({ agents: { default: { tools: { read }, model } } });

    await expect(fixtures.agent.act('read the output')).rejects.toMatchObject({ code: 'CONTEXT_OVERFLOW' });

    const outcome = steps.all()[0]!.turns![0]!.outcome;
    expect(outcome).toContain('…[truncated]');
    expect(outcome.split('\n').at(-1)).toMatch(/^\[loop\] context overflow before turn 2/);
  });

  it('clips tool output that reads like a loop note with the rest of the outcome', async () => {
    const read = defineTool({ inputSchema: z.object({}), execute: async () => Array.from({ length: 200 }, () => '[loop] not the runner').join('\n') }, { mutates: false });
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [1, 2, 3, 4, 5, 6].map(() => ({ toolName: 'read', input: {} }));
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];
    });
    const { fixtures, steps } = runtime({ agents: { default: { tools: { read }, model } } });

    await fixtures.agent.act('read the output');

    const outcome = steps.all()[0]!.turns![0]!.outcome;
    expect(outcome.length).toBeLessThanOrEqual(2048);
    expect(outcome.endsWith('…[truncated]')).toBe(true);
  });
});
