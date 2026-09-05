import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineBackend, type BackendHandle } from '../../src/backend/index.ts';
import { createBackendSession } from '../../src/backend/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { createAgent } from '../../src/agent/default-agent.ts';
import { defineTool, getToolContext } from '../../src/agent/tool.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';

/** A real fixture graph with an in-memory backend and no runner process or model provider. */
function runtime(backend: BackendHandle, overrides: E2EConfig = {}) {
  const config = resolveConfig({ targets: [{ name: 'fake', platform: 'custom', backend }], cache: 'off', ...overrides }, {
    projectRoot: process.cwd(), env: {},
  });
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const fixtures = createFixtures({
    config, target: config.targets[0]!, session: createBackendSession({ backend, targetName: 'fake' }),
    steps, budget: new AttemptBudget(signal, new Deadline(10_000)), runId: 'run', attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact' }, priorSteps: () => steps.completed(),
    agentContext: undefined, saveSession: undefined,
  });
  return { fixtures, steps };
}

const empty = () => defineBackend({ name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }) });

describe('explicit fixture operations', () => {
  it('opens the step before invoking a method, preserves sync accessors, and verifies contributed assertions', async () => {
    const accessor = () => ({ direct: true });
    const backend = defineBackend({
      name: 'fake', version: '1', spiVersion: 1,
      fixtures: {
        gadget: (context) => context.fixture('gadget', context.expectable({
          accessor,
          attach() {
            context.attachViewport({ width: 10, height: 20, scale: 1 });
            context.attachArtifact('log', 'hello.txt');
            return Promise.resolve();
          },
          fail(): Promise<void> { throw new Error('synchronous failure'); },
        }, () => context.fixture('expect', { toBeReady: async () => undefined }, { toBeReady: { kind: 'assertion' } })), {
          attach: { kind: 'resource' }, fail: { kind: 'resource' },
        }),
      },
    });
    const { fixtures, steps } = runtime(backend);
    const gadget = (fixtures as unknown as { gadget: { accessor: typeof accessor; attach(): Promise<void>; fail(): Promise<void> } }).gadget;
    expect(gadget.accessor).toBe(accessor);
    await gadget.attach();
    expect(steps.all()[0]).toMatchObject({ api: 'gadget.attach', viewport: { width: 10, height: 20 }, artifacts: ['artifact'] });
    await expect(gadget.fail()).rejects.toThrow('synchronous failure');
    await (expectFixture(gadget) as unknown as { toBeReady(): Promise<void> }).toBeReady();
    expect(steps.lastVerifiedStepIndex).toBe(2);
    expect(steps.all().map((step) => step.status)).toEqual(['passed', 'failed', 'passed']);
  });

  it('preserves the step scope of legacy fixture attachments after await', async () => {
    const backend = defineBackend({ name: 'legacy', version: '1', spiVersion: 1, fixtures: {
      gadget: (context) => ({ async capture() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        context.attachArtifact('log', 'later.txt');
      } }),
    } });
    const { fixtures, steps } = runtime(backend);
    await (fixtures as unknown as { gadget: { capture(): Promise<void> } }).gadget.capture();
    expect(steps.all()[0]?.artifacts).toEqual(['artifact']);
  });

  it('also marks legacy contributed assertions as verification steps', async () => {
    const backend = defineBackend({ name: 'legacy', version: '1', spiVersion: 1, fixtures: {
      gadget: (context) => context.expectable({}, () => ({ toBeReady: async () => undefined })),
    } });
    const { fixtures, steps } = runtime(backend);
    const gadget = (fixtures as unknown as { gadget: object }).gadget;
    await (expectFixture(gadget) as unknown as { toBeReady(): Promise<void> }).toBeReady();
    expect(steps.lastVerifiedStepIndex).toBe(0);
  });
});

describe('project tool dispatch', () => {
  it('reserves the only action slot before parallel model tool calls can mutate', async () => {
    let started = 0;
    const model = installFakeLoopModel(({ turn }) => turn === 1
      ? [{ toolName: 'mutate', input: {} }, { toolName: 'mutate', input: {} }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'finished' } }]);
    const executor = createAgent({ tools: {
      mutate: defineTool({ inputSchema: z.object({}), execute: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'done';
      } }, { mutates: true }),
    } });
    const { fixtures, steps } = runtime(empty(), { agent: { executor, model } });
    await expect(fixtures.agent.act('perform one mutation', undefined, { maxSteps: 1 })).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(started).toBe(1);
    expect(steps.all()[0]?.metrics?.actionSteps).toBe(1);
    expect(steps.all()[0]?.events.filter((event) => event.name === 'tool:mutate')).toHaveLength(1);
  });

  it('serializes grammar actions with project mutations and records failed tools accurately', async () => {
    const order: string[] = [];
    const backend = defineBackend({ name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [{ ref: { id: 'button', revision: '' }, role: 'button' }] }),
      perform: async () => { order.push('tap'); },
    });
    const { fixtures, steps } = runtime(backend, { agent: { executor: { name: 'test', async runStep(context) {
      await context.observe();
      const tool = context.budgets.runTool({ name: 'mutation', mutates: true }, async () => {
        order.push('start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('end');
        throw new Error('failed mutation');
      });
      const tap = context.actions.tap({ id: 'button' });
      await expect(tool).rejects.toThrow('failed mutation');
      await tap;
      return { status: 'passed', summary: 'checked' };
    } } } });
    await fixtures.agent.act('sequence');
    expect(order).toEqual(['start', 'end', 'tap']);
    expect(steps.all()[0]?.metrics?.actionSteps).toBe(2);
    expect(steps.all()[0]?.events.find((event) => event.name === 'tool:mutation')?.status).toBe('failed');
  });

  it('gives read-only tools the guarded observation capability', async () => {
    let path: string | undefined;
    let urlReads = 0;
    const backend = defineBackend({ name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [], url: 'app://device/settings/general' }),
      url: async () => { urlReads += 1; return 'app://device/wrong'; },
    });
    const model = installFakeLoopModel(({ turn }) => turn === 1
      ? [{ toolName: 'look', input: {} }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'looked' } }]);
    const executor = createAgent({ tools: {
      look: defineTool({ inputSchema: z.object({}), execute: async (_input, options) => {
        const observation = await getToolContext(options).observe({ pixels: true });
        path = observation.path;
        return observation.pixelsWithheld;
      } }, { mutates: false }),
    } });
    await runtime(backend, { agent: { executor, model } }).fixtures.agent.act('inspect');
    expect(path).toBe('/settings/general');
    expect(urlReads).toBe(0);
  });
});
