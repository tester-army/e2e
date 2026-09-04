/**
 * The executor owns its context (spec 16-executors.md, "Context is the
 * executor's"): attempt identity and lifecycle, structured prior steps, the
 * per-attempt memory, opt-in tree and pixels on `observe()`, per-executor
 * cache opt-out, and the built-in agent carrying its conversation across the
 * steps of a test. Real Playwright observations throughout.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LanguageModel, stepCountIs, ToolLoopAgent } from 'ai';
import type { ExecutorPriorStep, StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { compactSnapshotHistory } from '../../src/agent/default-agent.ts';
import { serializeLedger } from '../../src/agent/ledger.ts';
import { createToolLoopExecutor } from '../../src/agent/tool-loop.ts';
import {
  conversationMemory,
  createGrammarTools,
  createVerdictTool,
  trackModelCalls,
  VERDICT_RULES,
} from '../../src/agent/primitives.ts';
import type { ModelInstance } from '../../src/types.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const TWO_TESTS_SUITE = `import { test } from '@e2edev/e2e';

test('first test runs two steps', async ({ app, agent }) => {
  await app.open();
  await agent.act('step one');
  await agent.act('step two');
});

test('second test starts fresh', async ({ app, agent }) => {
  await app.open();
  await agent.act('step three');
});
`;

const ONE_STEP_SUITE = `import { test } from '@e2edev/e2e';

test('one act step', async ({ app, agent }) => {
  await app.open();
  await agent.act('look at the screen');
});
`;

const ONE_INCREMENT_SUITE = `import { test, expect } from '@e2edev/e2e';

test('raw loop increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

const TWO_INCREMENTS_SUITE = `import { test, expect } from '@e2edev/e2e';

test('the agent remembers its first step', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await agent.act('increment the counter again so it shows 2');
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

interface Probe {
  readonly instruction: string;
  readonly testId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly stepIndex: number;
  readonly priorSteps: readonly ExecutorPriorStep[];
  readonly memoryBefore: unknown;
  readonly signal: AbortSignal;
}

describe('the executor context: attempt, memory, and prior steps', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const probes: Probe[] = [];

  const probing: StepExecutor = {
    name: 'context-probe',
    version: '1',
    async runStep(context: StepExecutorContext) {
      probes.push({
        instruction: context.step.instruction,
        testId: context.attempt.testId,
        attemptId: context.attempt.attemptId,
        attemptIndex: context.attempt.index,
        stepIndex: context.step.index,
        priorSteps: context.priorSteps,
        memoryBefore: context.attempt.memory.get('probe'),
        signal: context.attempt.signal,
      });
      context.attempt.memory.set('probe', probes.length);
      return { status: 'passed', summary: `done: ${context.step.instruction}` };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/context.e2e.ts': TWO_TESTS_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: probing } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes both tests and ran every step through the executor', () => {
    expect(outcome.exitCode).toBe(0);
    expect(probes.map((probe) => probe.instruction)).toEqual(['step one', 'step two', 'step three']);
  });

  it('names the test and attempt, and numbers the step in the attempt timeline', () => {
    const first = resultByTitle(outcome, 'first test runs two steps');
    expect(probes[0]!.testId).toBe(first.test.id);
    expect(probes[0]!.attemptId).toBe(first.attempts[0]!.id);
    expect(probes[0]!.attemptIndex).toBe(0);
    // app.open is step 0.
    expect(probes[0]!.stepIndex).toBe(1);
    expect(probes[1]!.stepIndex).toBe(2);
    expect(probes[1]!.attemptId).toBe(probes[0]!.attemptId);
    expect(probes[2]!.attemptId).not.toBe(probes[0]!.attemptId);
  });

  it('hands over structured prior steps with the handoff of earlier verdicts', () => {
    expect(probes[0]!.priorSteps.map((step) => step.api)).toEqual(['app.open']);
    const second = probes[1]!.priorSteps;
    expect(second.map((step) => step.api)).toEqual(['app.open', 'agent.act']);
    expect(second[1]).toMatchObject({
      index: 1,
      kind: 'agent',
      label: 'step one',
      status: 'passed',
      explanation: 'done: step one',
    });
  });

  it('keeps memory across the steps of one attempt and never across tests', () => {
    expect(probes[0]!.memoryBefore).toBeUndefined();
    expect(probes[1]!.memoryBefore).toBe(1);
    expect(probes[2]!.memoryBefore).toBeUndefined();
  });

  it('ends the attempt signal once the attempt is over', () => {
    for (const probe of probes) expect(probe.signal.aborted).toBe(true);
  });
});

describe('observe() with the tree and pixels', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let seen: Awaited<ReturnType<StepExecutorContext['observe']>> | undefined;

  const looking: StepExecutor = {
    name: 'looker',
    async runStep(context: StepExecutorContext) {
      seen = await context.observe({ tree: true, pixels: true });
      return { status: 'passed', summary: 'looked' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/look.e2e.ts': ONE_STEP_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: looking } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('returns the redacted tree beside the text, with the same node ids', () => {
    expect(outcome.exitCode).toBe(0);
    expect(seen?.tree).toBeDefined();
    const ids = new Set<string>();
    const walk = (node: NonNullable<typeof seen>['tree']): void => {
      if (node === undefined) return;
      ids.add(node.id);
      for (const child of node.children ?? []) walk(child);
    };
    walk(seen!.tree);
    const incrementId = nodeIdFor(seen!.text, /button "Increment"/);
    expect(ids.has(incrementId)).toBe(true);
    expect(JSON.stringify(seen!.tree)).not.toContain('selector');
  });

  it('returns masked pixels when the backend can prove masking', () => {
    expect(seen?.pixelsWithheld).toBeUndefined();
    expect(seen?.pixels).toBeDefined();
    expect(seen!.pixels!.width).toBeGreaterThan(0);
    expect(seen!.pixels!.data.byteLength).toBeGreaterThan(0);
    expect(seen!.pixels!.mediaType).toMatch(/^image\//);
  });

  it('records the pixel decision as a policy event on the step', () => {
    const attempt = resultByTitle(outcome, 'one act step').attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.act')!;
    expect(step.events).toContainEqual(
      expect.objectContaining({ kind: 'policy', name: 'vision.pixels', decision: 'allowed' }),
    );
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
  });
});

describe('an executor that opts out of the trace cache', () => {
  let app: FixtureApp;
  let cached: RunOutcome;
  let uncached: RunOutcome;
  const projects: FixtureProject[] = [];

  const passing = (cache?: 'off'): StepExecutor => ({
    name: 'passer',
    ...(cache === undefined ? {} : { cache }),
    async runStep() {
      return { status: 'passed', summary: 'nothing to do' };
    },
  });

  beforeAll(async () => {
    app = await startFixtureApp();
    for (const [mode, sink] of [
      [undefined, (outcome: RunOutcome) => (cached = outcome)],
      ['off', (outcome: RunOutcome) => (uncached = outcome)],
    ] as const) {
      const result = await runProject(
        { 'tests/cache.e2e.ts': ONE_STEP_SUITE },
        {
          appUrl: app.url,
          config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', agent: passing(mode) },
        },
      );
      sink(result.outcome);
      projects.push(result.project);
    }
  }, 180_000);

  afterAll(async () => {
    for (const project of projects) project.cleanup();
    await app?.close();
  });

  const actStep = (outcome: RunOutcome) =>
    resultByTitle(outcome, 'one act step').attempts.at(-1)!.steps.find((step) => step.api === 'agent.act')!;

  it('leaves no cache participation on its steps, where the default executor has one', () => {
    expect(cached.exitCode).toBe(0);
    expect(uncached.exitCode).toBe(0);
    expect(actStep(cached).cache).toBeDefined();
    expect(actStep(uncached).cache).toBeUndefined();
  });
});

describe('cross-step memory on the chassis, composed from primitives', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => {
      // Each step is one tap then one conclusion; the carried history of the
      // first step makes the second step's tool results start at two.
      if (call.toolResults.length % 2 === 0) {
        const id = nodeIdFor(call.lastPrompt, /button "Increment"/);
        return [{ toolName: 'tap', input: { target: id } }];
      }
      return [
        {
          toolName: 'complete_step',
          input: { status: 'passed', summary: 'tapped Increment once' },
        },
      ];
    });
    // The default agent's loop and grammar, with a prompt that carries the
    // conversation across steps: no chassis change, no createAgent option.
    const remembering = createToolLoopExecutor({
      name: 'remembering-agent',
      system: 'Use the tools to act on node ids from the newest screen; conclude with complete_step.',
      prepareMessages: compactSnapshotHistory,
      tools: (ctx, { guard }) => createGrammarTools(ctx, { guard }),
      buildPrompt: async (ctx) => {
        const memory = conversationMemory(ctx);
        // Steps that ran since the model's last turn — a replayed step, a
        // screen.* call — become a note; the conversation covers the rest.
        const since = ctx.priorSteps.filter((step) => step.index > memory.lastStepIndex);
        const history =
          memory.messages.length === 0
            ? `Previously completed steps:\n${ctx.ledger}`
            : since.length === 0
              ? undefined
              : `Steps completed since your last turn:\n${serializeLedger(since, 4_096).text}`;
        const screen = await ctx.observe();
        const content = [
          `Execute this test step: ${ctx.step.instruction}`,
          history,
          `Current screen (revision ${screen.revision}):\n${screen.text}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join('\n\n');
        return [...memory.messages, { role: 'user', content }];
      },
      onConclude: (ctx, { messages }) => conversationMemory(ctx).remember(messages),
    });
    const result = await runProject(
      { 'tests/memory.e2e.ts': TWO_INCREMENTS_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          cache: 'off',
          agent: { model, executor: remembering },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes with the counter at 2', () => {
    expect(resultByTitle(outcome, 'the agent remembers its first step').status).toBe('passed');
    expect(loopCalls).toHaveLength(4);
  });

  it('opens the first step with the ledger and the second with its own conversation', () => {
    const firstStep = loopCalls[0]!;
    expect(firstStep.userMessages).toBe(1);
    expect(firstStep.prompt).toContain('Previously completed steps');
    expect(firstStep.prompt).toContain('app.open');

    const secondStep = loopCalls[2]!;
    expect(secondStep.userMessages).toBeGreaterThanOrEqual(2);
    // The first user message is still the first step's request...
    expect(secondStep.prompt).toContain('increment the counter once');
    // ...the last is this step's, and the first step's tool results ride along.
    expect(secondStep.lastPrompt).toContain('so it shows 2');
    expect(secondStep.lastPrompt).not.toContain('Previously completed steps');
    expect(secondStep.toolResults[0]).toContain('Updated screen');
  });
});

describe('a raw ToolLoopAgent over the primitives, no chassis', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  const raw = (model: ModelInstance): StepExecutor => ({
    name: 'raw-loop',
    async runStep(ctx) {
      const verdict = createVerdictTool();
      const tracker = trackModelCalls(ctx, model);
      const agent = new ToolLoopAgent({
        model: model as unknown as LanguageModel,
        instructions: `Drive the step with the tools. ${VERDICT_RULES}`,
        tools: { ...createGrammarTools(ctx), complete_step: verdict.tool },
        toolChoice: 'required',
        stopWhen: [() => verdict.concluded(), stepCountIs(ctx.budgets.maxModelCalls)],
      });
      const observation = await ctx.observe();
      await agent.generate({
        prompt: `${ctx.step.instruction}\n\nCurrent screen (revision ${observation.revision}):\n${observation.text}`,
        abortSignal: ctx.signal,
        onStepStart: tracker.onStepStart,
        onStepEnd: tracker.onStepEnd,
      });
      return verdict.verdict() ?? { status: 'failed', summary: 'no verdict', errorCode: 'STEP_NO_CONCLUSION' };
    },
  });

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => {
      if (call.lastToolResult === '') {
        const id = nodeIdFor(call.prompt, /button "Increment"/);
        return [{ toolName: 'tap', input: { target: id } }];
      }
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'tapped once' } }];
    });
    const result = await runProject(
      { 'tests/raw.e2e.ts': ONE_INCREMENT_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', cache: 'off', agent: raw(model) } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes, with the grammar policed and the model calls accounted by the harness', () => {
    const result = resultByTitle(outcome, 'raw loop increments the counter');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
    expect(step.metrics!.actionSteps).toBe(1);
    expect(step.metrics!.modelCalls).toBe(2);
    expect(step.model).toMatchObject({ provider: 'fake-loop', model: 'scripted-loop' });
    expect(loopCalls[0]!.toolNames).toContain('complete_step');
    expect(loopCalls[0]!.toolNames).toContain('tap');
  });
});
