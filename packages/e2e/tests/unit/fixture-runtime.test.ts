import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { credentials, secrets, setSecretRegistry } from '../../src/secrets.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import { createAgent } from '../../src/agent/default-agent.ts';
import { defineTool, getToolContext } from '../../src/agent/tool.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(engine: EngineHandle, overrides: E2EConfig = {}) {
  const config = resolveConfig({ targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides }, {
    projectRoot: process.cwd(), env: {},
  });
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const registerArtifact = vi.fn(() => 'artifact');
  const { fixtures } = createFixtures({
    config, target: config.targets[0]!, session: createEngineSession({ engine, targetName: 'fake' }),
    steps, budget: new AttemptBudget(signal, new Deadline(10_000)), runId: 'run', attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: registerArtifact }, priorSteps: () => steps.completed(),
    agentContext: undefined, saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps, config, registerArtifact };
}

const empty = () => defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }) });

describe('explicit screenshot secrecy', () => {
  it.each(['static', 'provider'] as const)('captures before a %s secret fill and denies capture and registration afterward', async (source) => {
    const sentinel = 'synthetic-screenshot-secret-2718';
    const screenshot = vi.fn(async () => 'screenshots/evidence.png');
    let filled: string | undefined;
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [{ ref: { id: 'echo', revision: '' }, role: 'status', text: filled ?? '' }] }),
      locate: async () => [{ ref: { id: 'password', revision: '' }, role: 'textbox', states: { secure: true } }],
      perform: async (_ref, action) => { if (action.kind === 'fill') filled = action.value; },
      artifacts: { screenshot },
    });
    const { fixtures, steps, config, registerArtifact } = runtime(engine, {
      credentials: { member: { username: 'ada', password: source === 'static' ? sentinel : async () => sentinel } },
    });
    setSecretRegistry(config);
    try {
      await expect(fixtures.app.screenshot('before-fill')).resolves.toBe('screenshots/evidence.png');
      expect(screenshot).toHaveBeenCalledExactlyOnceWith('before-fill', expect.any(Object));
      expect(registerArtifact).toHaveBeenCalledExactlyOnceWith('screenshot', 'screenshots/evidence.png');
      screenshot.mockClear();
      registerArtifact.mockClear();

      await fixtures.screen.getByRole('textbox').fill(credentials.user('member').password);
      expect(filled).toBe(sentinel);
      await expect(fixtures.app.screenshot('after-fill')).rejects.toMatchObject({
        code: 'POLICY_DENIED', category: 'configuration',
      });
      expect(screenshot).not.toHaveBeenCalled();
      expect(registerArtifact).not.toHaveBeenCalled();
      expect(steps.all().at(-1)).toMatchObject({
        api: 'app.screenshot', status: 'failed', artifacts: [], error: { code: 'POLICY_DENIED' },
      });
      expect(JSON.stringify(steps.all())).not.toContain(sentinel);
    } finally {
      setSecretRegistry(undefined);
    }
  });

  it('still captures when a credential provider fails before supplying a secret', async () => {
    const screenshot = vi.fn(async () => 'screenshots/evidence.png');
    const { fixtures, config, registerArtifact } = runtime(defineEngine({
      name: 'fake', version: '1', spiVersion: 1, artifacts: { screenshot },
    }), {
      credentials: { member: { username: 'ada', password: async () => '' } },
    });
    setSecretRegistry(config);
    try {
      await expect(fixtures.screen.getByRole('textbox').fill(credentials.user('member').password)).rejects.toMatchObject({
        code: 'AUTH_CREDENTIAL_UNAVAILABLE',
      });
      await expect(fixtures.app.screenshot()).resolves.toBe('screenshots/evidence.png');
      expect(screenshot).toHaveBeenCalledOnce();
      expect(registerArtifact).toHaveBeenCalledExactlyOnceWith('screenshot', 'screenshots/evidence.png');
    } finally {
      setSecretRegistry(undefined);
    }
  });
});

describe('generic secrets', () => {
  it('fills a config.secrets value into a plain textbox, redacts it from steps, and taints the session', async () => {
    const apiKey = 'sk_live_generic_2718';
    let filled: string | undefined;
    const screenshot = vi.fn(async () => 'screenshots/evidence.png');
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [{ ref: { id: 'echo', revision: '' }, role: 'status', text: filled ?? '' }] }),
      locate: async () => [{ ref: { id: 'key', revision: '' }, role: 'textbox', name: 'API key' }],
      perform: async (_ref, action) => { if (action.kind === 'fill') filled = action.value; },
      artifacts: { screenshot },
    });
    const { fixtures, steps, config } = runtime(engine, { secrets: { 'stripe-key': apiKey } });
    setSecretRegistry(config);
    try {
      const handle = secrets.get('stripe-key');
      expect(handle).toMatchObject({ name: 'stripe-key', purpose: 'generic-secret' });
      expect(JSON.stringify(handle)).not.toContain(apiKey);
      await fixtures.screen.getByLabel('API key').fill(handle);
      expect(filled).toBe(apiKey);
      await expect(fixtures.app.screenshot('after-fill')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(JSON.stringify(steps.all())).not.toContain(apiKey);
    } finally {
      setSecretRegistry(undefined);
    }
  });

  it('fails a secret the config does not declare with SECRET_UNAVAILABLE', () => {
    const { config } = runtime(empty(), { secrets: { known: 'v' } });
    setSecretRegistry(config);
    try {
      expect(() => secrets.get('unknown')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
      expect(() => secrets.get('unknown')).toThrow(/E2E_SECRET_UNKNOWN/);
    } finally {
      setSecretRegistry(undefined);
    }
    expect(() => secrets.get('known')).toThrow(/runner is active/);
  });
});

describe('explicit fixture operations', () => {
  it('preserves mutable state, identity, and private-field receivers', async () => {
    class Counter {
      count = 0;
      #value = 0;
      /** Mutates both public and private fixture state. */
      async increment(): Promise<void> { this.count += 1; this.#value += 1; }
      /** Reads state synchronously using the original receiver. */
      read(): number { return this.#value; }
      /** Exposes private state through an accessor. */
      get value(): number { return this.#value; }
    }
    const counter = new Counter();
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, fixtures: {
      counter: (context) => context.fixture('counter', counter, { increment: { kind: 'resource' } }),
    } });
    const { fixtures, steps } = runtime(engine);
    const fixture = (fixtures as unknown as { counter: Counter }).counter;
    await fixture.increment();
    expect(fixture.count).toBe(1);
    expect(fixture.read()).toBe(1);
    expect(fixture.value).toBe(1);
    fixture.count = 10;
    await fixture.increment();
    expect(counter.count).toBe(11);
    expect(fixture).toBe(counter);
    expect(steps.all().map((step) => step.api)).toEqual(['counter.increment', 'counter.increment']);
  });

  it('wraps live namespaces once while preserving their getters and setters', async () => {
    class Counter {
      constructor(public count: number) {}
      /** Updates the namespace receiver. */
      async increment(): Promise<void> { this.count += 1; }
    }
    const first = new Counter(0);
    const second = new Counter(10);
    let reads = 0;
    class Gadget {
      #counter = first;
      plain = first;
      /** Reads a namespace through a private-field accessor on the prototype. */
      get counter(): Counter { reads += 1; return this.#counter; }
      /** Replaces the live namespace. */
      set counter(value: Counter) { this.#counter = value; }
    }
    const original = new Gadget();
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, fixtures: {
      gadget: (context) => context.fixture('gadget', original, {
        counter: { increment: { kind: 'resource' } },
        plain: {},
      }),
    } });
    const { fixtures, steps } = runtime(engine);
    const gadget = (fixtures as unknown as { gadget: typeof original }).gadget;
    expect(reads).toBe(0);
    await gadget.counter.increment();
    await gadget.counter.increment();
    gadget.counter = second;
    await gadget.counter.increment();
    gadget.plain = second;
    expect(gadget.plain).toBe(second);
    expect(first.count).toBe(2);
    expect(second.count).toBe(11);
    expect(steps.all()).toHaveLength(3);
  });

  it('opens the step before invoking a method, preserves sync accessors, and verifies contributed assertions', async () => {
    const accessor = () => ({ direct: true });
    const engine = defineEngine({
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
    const { fixtures, steps } = runtime(engine);
    const gadget = (fixtures as unknown as { gadget: { accessor: typeof accessor; attach(): Promise<void>; fail(): Promise<void> } }).gadget;
    expect(gadget.accessor).toBe(accessor);
    await gadget.attach();
    expect(steps.all()[0]).toMatchObject({ api: 'gadget.attach', viewport: { width: 10, height: 20 }, artifacts: ['artifact'] });
    await expect(gadget.fail()).rejects.toThrow('synchronous failure');
    await (expectFixture(gadget) as unknown as { toBeReady(): Promise<void> }).toBeReady();
    expect(steps.lastVerifiedStepIndex).toBe(2);
    expect(steps.all().map((step) => step.status)).toEqual(['passed', 'failed', 'passed']);
  });

  it('rejects a factory that returns a surface it did not declare through context.fixture', () => {
    const engine = defineEngine({ name: 'undeclared', version: '1', spiVersion: 1, fixtures: {
      gadget: () => ({ async capture() {} }),
    } });
    const { fixtures } = runtime(engine);
    expect(() => (fixtures as unknown as { gadget: object }).gadget).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('fixture "gadget"') }),
    );
  });

  it('rejects a factory that returns a surface another fixture declared', () => {
    let shared: object | undefined;
    const engine = defineEngine({ name: 'aliased', version: '1', spiVersion: 1, fixtures: {
      gadget: (context) => {
        shared = context.fixture('gadget', { async capture() {} }, { capture: { kind: 'resource' } });
        return shared;
      },
      widget: (context) => shared ?? context.fixture('gadget', { async capture() {} }, { capture: { kind: 'resource' } }),
    } });
    const { fixtures } = runtime(engine);
    const surfaces = fixtures as unknown as { gadget: object; widget: object };
    expect(surfaces.gadget).toBe(shared);
    expect(() => surfaces.widget).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('declared as "gadget"') }),
    );
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
    const { fixtures, steps } = runtime(empty(), { agents: { default: { executor, model } } });
    await expect(fixtures.agent.act('perform one mutation', { maxSteps: 1 })).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(started).toBe(1);
    expect(steps.all()[0]?.metrics?.actionSteps).toBe(1);
    expect(steps.all()[0]?.events.filter((event) => event.name === 'tool:mutate')).toHaveLength(1);
  });

  it('serializes grammar actions with project mutations and records failed tools accurately', async () => {
    const order: string[] = [];
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [{ ref: { id: 'button', revision: '' }, role: 'button' }] }),
      perform: async () => { order.push('tap'); },
    });
    const { fixtures, steps } = runtime(engine, { agents: { default: { executor: { name: 'test', async runStep(context) {
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
    } } } } });
    await fixtures.agent.act('sequence');
    expect(order).toEqual(['start', 'end', 'tap']);
    expect(steps.all()[0]?.metrics?.actionSteps).toBe(2);
    expect(steps.all()[0]?.events.find((event) => event.name === 'tool:mutation')?.status).toBe('failed');
  });

  it('gives read-only tools the guarded observation capability', async () => {
    let path: string | undefined;
    let urlReads = 0;
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1,
      observe: async () => ({ nodes: [], url: 'app://device/settings/general' }),
      url: async () => { urlReads += 1; return 'app://device/wrong'; },
    });
    const model = installFakeLoopModel(({ turn }) => turn === 1
      ? [{ toolName: 'inspect', input: {} }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'looked' } }]);
    const executor = createAgent({ tools: {
      inspect: defineTool({ inputSchema: z.object({}), execute: async (_input, options) => {
        const observation = await getToolContext(options).observe({ pixels: true });
        path = observation.path;
        return observation.pixelsWithheld;
      } }, { mutates: false }),
    } });
    await runtime(engine, { agents: { default: { executor, model } } }).fixtures.agent.act('inspect');
    expect(path).toBe('/settings/general');
    expect(urlReads).toBe(0);
  });

  it("rejects a project tool that takes one of the agent's own tool names", () => {
    const tool = defineTool({ inputSchema: z.object({}), execute: async () => 'shadowed' }, { mutates: false });
    for (const name of ['screenshot', 'tap', 'observe', 'complete_step']) {
      expect(() => createAgent({ tools: { [name]: tool } })).toThrow(`the ${name} tool name is reserved`);
    }
  });
});
