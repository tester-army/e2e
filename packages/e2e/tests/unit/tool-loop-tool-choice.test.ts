import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../../src/agent/default-agent.ts';
import { isForcedToolChoiceRejected } from '../../src/agent/model/tool-choice.ts';
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
import { installFakeLoopModel, loopCalls, type LoopResponder } from '../helpers/fake-loop-model.ts';

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(overrides: E2EConfig = {}) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }) });
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
    artifacts: { dir: '/tmp', register: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

/** What Anthropic answers, and the gateway forwards, when a model does not take a forced tool choice. */
const REJECTION = Object.assign(new Error('tool_choice: type "tool" and "any" are not supported for this model.'), {
  statusCode: 400,
});

/** A read-only project tool, so a turn can do something other than conclude. */
const peek = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });

const conclude = { toolName: 'complete_step', input: { status: 'passed', summary: 'done' } };

/** A model that refuses every forced choice and otherwise follows the script. */
function refusingForcedChoice(respond: LoopResponder): LoopResponder {
  return (call) => {
    if (call.toolChoice !== 'auto') throw REJECTION;
    return respond(call);
  };
}

describe('tool loop forced tool choice', () => {
  it('retries with auto and a tool-calls-only rule when the model rejects a forced choice', async () => {
    const model = installFakeLoopModel(
      refusingForcedChoice(({ turn }) => (turn === 2 ? [{ toolName: 'peek', input: {} }] : [conclude])),
    );
    const { fixtures, steps } = runtime({ agents: { default: { executor: createAgent({ tools: { peek } }), model } } });

    await fixtures.agent.act('look around');

    expect(loopCalls.map((call) => call.toolChoice)).toEqual(['required', 'auto', 'auto']);
    // The retried request is the refused one, sent again under the new rule.
    expect(loopCalls[1]!.prompt).toBe(loopCalls[0]!.prompt);
    expect(loopCalls[0]!.system).not.toContain('Reply with tool calls only');
    expect(loopCalls[1]!.system).toContain('Reply with tool calls only');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    // The refused request never answered, so it is not a model call the step paid for.
    expect(step.metrics?.modelCalls).toBe(2);
  });

  it('remembers the refusal for later steps on the same model', async () => {
    const model = installFakeLoopModel(refusingForcedChoice(() => [conclude]));
    const { fixtures } = runtime({ agents: { default: { executor: createAgent(), model } } });

    await fixtures.agent.act('first');
    await fixtures.agent.act('second');

    expect(loopCalls.map((call) => call.toolChoice)).toEqual(['required', 'auto', 'auto']);
  });

  it('offers only complete_step under auto on the forced-conclusion turns', async () => {
    const model = installFakeLoopModel(
      refusingForcedChoice(({ toolNames }) =>
        toolNames.length === 1 && toolNames[0] === 'complete_step' ? [conclude] : [{ toolName: 'peek', input: {} }],
      ),
    );
    const { fixtures, steps } = runtime({
      agents: { default: { executor: createAgent({ tools: { peek } }), model, maxModelCalls: 4 } },
    });

    await fixtures.agent.act('look until told to stop');

    const last = loopCalls.at(-1)!;
    expect(last.toolNames).toEqual(['complete_step']);
    expect(last.toolChoice).toBe('auto');
    expect(steps.all()[0]!.status).toBe('passed');
  });

  it('asks again when a turn comes back as prose without a tool call', async () => {
    const model = installFakeLoopModel(
      refusingForcedChoice(({ turn }) => (turn === 2 ? { text: 'I will look around first.' } : [conclude])),
    );
    const { fixtures, steps } = runtime({ agents: { default: { executor: createAgent(), model } } });

    await fixtures.agent.act('do the thing');

    expect(loopCalls).toHaveLength(3);
    expect(loopCalls[2]!.lastPrompt).toContain('Your last reply had no tool call');
    expect(loopCalls[2]!.userMessages).toBe(loopCalls[1]!.userMessages + 1);
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    // The refused request is not a model call; the prose turn is one the step paid for.
    expect(step.metrics?.modelCalls).toBe(2);
  });

  it('fails with STEP_NO_CONCLUSION when prose replies use up the turns', async () => {
    const model = installFakeLoopModel(refusingForcedChoice(() => ({ text: 'Thinking about it.' })));
    const { fixtures } = runtime({ agents: { default: { executor: createAgent(), model, maxModelCalls: 3 } } });

    await expect(fixtures.agent.act('do the thing')).rejects.toMatchObject({ code: 'STEP_NO_CONCLUSION' });
    // One refusal, then three prose turns: the budget, not the loop, ends it.
    expect(loopCalls).toHaveLength(4);
  });

  it('leaves a 400 about anything else to the ordinary error translation', async () => {
    const model = installFakeLoopModel(() => {
      throw Object.assign(new Error('Invalid API key provided'), { statusCode: 400 });
    });
    const { fixtures } = runtime({ agents: { default: { executor: createAgent(), model } } });

    await expect(fixtures.agent.act('do the thing')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(loopCalls).toHaveLength(1);
  });
});

describe('isForcedToolChoiceRejected', () => {
  it('reads the provider message through a gateway wrapper and a spent retry chain', () => {
    expect(isForcedToolChoiceRejected(REJECTION)).toBe(true);
    expect(isForcedToolChoiceRejected(new Error('wrapped', { cause: REJECTION }))).toBe(true);
    expect(isForcedToolChoiceRejected({ message: 'retries spent', lastError: REJECTION })).toBe(true);
    expect(
      isForcedToolChoiceRejected({ statusCode: 400, message: 'Bad Request', responseBody: '{"error":{"message":"tool_choice is not supported"}}' }),
    ).toBe(true);
  });

  it('ignores server failures and unrelated messages that mention tools', () => {
    expect(isForcedToolChoiceRejected(Object.assign(new Error('tool_choice is not supported'), { statusCode: 502 }))).toBe(false);
    expect(isForcedToolChoiceRejected(new Error('tool_choice must name a defined tool'))).toBe(false);
    expect(isForcedToolChoiceRejected(new Error('Rate limit reached'))).toBe(false);
    expect(isForcedToolChoiceRejected(undefined)).toBe(false);
  });
});
