import { afterAll, beforeAll, expect, it } from 'vitest';
import { AgentError } from 'e2e-core/lib/agent/error';
import type { StepExecutor } from 'e2e-core/lib/agent/executor';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

let app: FixtureApp;
beforeAll(async () => {
  app = await startFixtureApp();
});
afterAll(async () => {
  await app?.close();
});

/** One assertion against the real browser, with caller-supplied options. */
function suite(options: string): string {
  return `import { test } from 'e2e';
  test('explores', async ({ app, agent }) => {
    await app.open();
    await agent.assert('the counter shows zero', ${options});
  });`;
}

it('routes built-in exploring asserts through a scroll-only loop with pixels alone', async () => {
  const model = installFakeLoopModel((call) =>
    call.turn === 1
      ? [{ toolName: 'scroll', input: { direction: 'down' } }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'observed across viewports' } }],
  );
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite("{ explore: true, vision: 'only' }") },
    {
      appUrl: app.url,
      config: { agents: { default: { model } } },
    },
  );
  try {
    const result = resultByTitle(outcome, 'explores');
    expect(result.attempts.at(-1)?.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(loopCalls).toHaveLength(2);
    expect(loopCalls[0]!.toolNames).toEqual(['complete_step', 'observe', 'screenshot', 'scroll', 'scroll_to']);
    expect(loopCalls[0]!.imageParts).toBeGreaterThan(0);
    expect(loopCalls[0]!.prompt).not.toContain('Increment');
    expect(loopCalls[0]!.prompt).not.toContain('Previously completed steps');
    expect(loopCalls[1]!.lastToolResult).not.toContain('Increment');
    const step = result.attempts.at(-1)!.steps.find((s) => s.api === 'agent.assert')!;
    expect(step.metrics?.actionSteps).toBe(1);
    expect(step.cache).toBeUndefined();
  } finally {
    project.cleanup();
  }
});

it.each([
  '{ maxSteps: 2 }',
  '{ explore: false, maxModelCalls: 2 }',
  '{ explore: "yes" }',
  '{ explore: true, timeout: null }',
  '{ explore: true, maxSteps: null }',
  '{ explore: true, maxModelCalls: null }',
])('rejects invalid exploration options %s', async (options) => {
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite(options) },
    {
      appUrl: app.url,
      config: {
        agents: {
          default: {
            executor: {
              name: 'unused',
              async runStep() {
                throw new Error('must not run');
              },
            },
          },
        },
      },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('INVALID_ARGUMENT');
  } finally {
    project.cleanup();
  }
});

it('maps exhausted exploration to ASSERTION_INCONCLUSIVE', async () => {
  const executor: StepExecutor = {
    name: 'exhaust',
    async runStep(context) {
      await context.actions.scroll('down');
      try {
        await context.actions.scroll('down');
      } catch {
        /* A hard stop must override a success verdict. */
      }
      return { status: 'passed', summary: 'must not pass' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{ explore: true, maxSteps: 1 }') },
    {
      appUrl: app.url,
      config: { agents: { default: { executor } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('ASSERTION_INCONCLUSIVE');
    expect(outcome.exitCode).toBe(1);
  } finally {
    project.cleanup();
  }
});

it.each(['navigate', 'tool'] as const)('denies custom executor mutations through %s', async (action) => {
  let executed = false;
  const executor: StepExecutor = {
    name: 'mutation-probe',
    async runStep(context) {
      try {
        if (action === 'navigate') await context.actions.navigate('/checkout');
        else
          await context.budgets.runTool({ name: 'write', mutates: true }, async () => {
            executed = true;
          });
      } catch {
        /* A caught policy failure must still fail the step. */
      }
      return { status: 'passed', summary: 'must not pass' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{}') },
    {
      appUrl: app.url,
      config: { agents: { default: { executor } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('POLICY_DENIED');
    expect(executed).toBe(false);
  } finally {
    project.cleanup();
  }
});

it('treats a built-in loop without a verdict at its model-call ceiling as inconclusive', async () => {
  const model = installFakeLoopModel(() => [{ toolName: 'observe', input: {} }]);
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{ explore: true, maxModelCalls: 1 }') },
    {
      appUrl: app.url,
      config: { agents: { default: { model } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('ASSERTION_INCONCLUSIVE');
  } finally {
    project.cleanup();
  }
});

it('caps the default exploration budgets at configured limits', async () => {
  let budgets: number[] = [];
  const executor: StepExecutor = {
    name: 'budget-probe',
    async runStep(context) {
      budgets = [context.budgets.maxActions, context.budgets.maxModelCalls];
      return { status: 'passed', summary: 'observed' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{ explore: true }') },
    {
      appUrl: app.url,
      config: { agents: { default: { executor, maxSteps: 2, maxModelCalls: 3 } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').status).toBe('passed');
    expect(budgets).toEqual([2, 3]);
  } finally {
    project.cleanup();
  }
});

it('allows scrolling a listed node into view', async () => {
  const executor: StepExecutor = {
    name: 'scroll-to-probe',
    async runStep(context) {
      const observation = await context.observe();
      await context.actions.scrollTo({ id: nodeIdFor(observation.text, /button "Increment"/) });
      return { status: 'passed', summary: 'node reached' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{ explore: true }') },
    {
      appUrl: app.url,
      config: { agents: { default: { executor } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').status).toBe('passed');
  } finally {
    project.cleanup();
  }
});

it('retains every viewport image for assertions spanning more than four screenshots', async () => {
  const model = installFakeLoopModel((call) =>
    call.turn < 6
      ? [{ toolName: 'scroll', input: { direction: call.turn % 2 === 0 ? 'up' : 'down' } }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'combined all viewport evidence' } }],
  );
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite("{ explore: true, vision: 'only', maxModelCalls: 8 }") },
    {
      appUrl: app.url,
      config: { agents: { default: { model } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').status).toBe('passed');
    expect(loopCalls).toHaveLength(6);
    expect(loopCalls.at(-1)!.imageParts).toBeGreaterThanOrEqual(6);
  } finally {
    project.cleanup();
  }
});

it('fails inconclusively instead of dropping evidence after context overflow', async () => {
  const model = installFakeLoopModel((call) => {
    if (call.turn === 1) return [{ toolName: 'scroll', input: { direction: 'down' } }];
    expect(call.imageParts).toBe(2);
    throw new Error('context_length_exceeded');
  });
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite("{ explore: true, vision: 'only' }") },
    {
      appUrl: app.url,
      config: { agents: { default: { model } } },
    },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('ASSERTION_INCONCLUSIVE');
    expect(loopCalls).toHaveLength(2);
  } finally {
    project.cleanup();
  }
});

it.each(['', ', vision: false'])('keeps a noninteractive assertion tree-only by default%s', async (vision) => {
  const model = installFakeLoopModel(() => [
    { toolName: 'complete_step', input: { status: 'passed', summary: 'read semantic evidence' } },
  ]);
  const files = {
    'tests/explore.e2e.ts': suite(`{ explore: true${vision} }`).replace(
      'await app.open();',
      "await app.open('/canvas-bare');",
    ),
  };
  const { outcome, project } = await runProject(files, { appUrl: app.url, config: { agents: { default: { model } } } });
  try {
    expect(resultByTitle(outcome, 'explores').status).toBe('passed');
    expect(loopCalls[0]!.imageParts).toBe(0);
    expect(loopCalls[0]!.toolNames).not.toContain('screenshot');
  } finally {
    project.cleanup();
  }
});

it.each(['{}', '{ explore: true, vision: true }', "{ explore: true, vision: 'only' }"])('lets a vision-capable custom executor choose tree-only or pixel evidence with %s', async (options) => {
  let text = '';
  let treeOnlyPixels: unknown;
  let requestedPixels: unknown;
  const executor: StepExecutor = {
    name: 'custom-vision',
    vision: true,
    async runStep(context) {
      const observation = await context.observe({ pixels: false });
      text = observation.text;
      treeOnlyPixels = observation.pixels;
      requestedPixels = (await context.observe({ pixels: true })).pixels;
      return { status: 'passed', summary: 'read the supplied observation' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite(options) },
    { appUrl: app.url, config: { agents: { default: { executor } } } },
  );
  try {
    expect(resultByTitle(outcome, 'explores').status).toBe('passed');
    expect(text).toContain('Increment');
    expect(treeOnlyPixels).toBeUndefined();
    expect(requestedPixels).toBeDefined();
  } finally {
    project.cleanup();
  }
});

it.each(['budget', 'timeout'] as const)('maps a thrown assertion %s hard stop to inconclusive', async (stop) => {
  const executor: StepExecutor = {
    name: 'throwing-hard-stop',
    async runStep(context) {
      if (stop === 'budget') {
        await context.actions.scroll('down');
        await context.actions.scroll('down');
      } else {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw context.signal.reason;
      }
      return { status: 'passed', summary: 'must not pass' };
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite(`{ explore: true, maxSteps: 1${stop === 'timeout' ? ', timeout: 100' : ''} }`) },
    { appUrl: app.url, config: { agents: { default: { executor } } } },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('ASSERTION_INCONCLUSIVE');
  } finally {
    project.cleanup();
  }
});

it('maps vouched exhaustion without a recorded hard stop to inconclusive', async () => {
  const executor: StepExecutor = {
    name: 'self-accounted-exhaustion',
    async runStep(context) {
      context.budgets.recordModelCall(undefined);
      throw new AgentError('STEP_BUDGET_EXHAUSTED', 'the model-call budget was used');
    },
  };
  const { outcome, project } = await runProject(
    { 'tests/explore.e2e.ts': suite('{ explore: true, maxModelCalls: 1 }') },
    { appUrl: app.url, config: { agents: { default: { executor } } } },
  );
  try {
    expect(resultByTitle(outcome, 'explores').attempts.at(-1)?.error?.code).toBe('ASSERTION_INCONCLUSIVE');
  } finally {
    project.cleanup();
  }
});
