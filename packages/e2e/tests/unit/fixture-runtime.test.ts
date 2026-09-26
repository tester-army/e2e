import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEngine, EngineError, type EngineHandle, LOCATOR_ACTION_KINDS, TestError } from '../../src/engine/index.ts';
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
import type { StepExecutor } from '../../src/agent/executor.ts';
import { defineTool, getToolContext } from '../../src/agent/tool.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(engine: EngineHandle, overrides: Partial<E2EConfig> = {}) {
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

const empty = () => defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });

describe('explicit screenshot secrecy', () => {
  it.each(['static', 'provider'] as const)('captures before a %s secret fill and denies capture and registration afterward', async (source) => {
    const sentinel = 'synthetic-screenshot-secret-2718';
    const screenshot = vi.fn(async () => 'screenshots/evidence.png');
    let filled: string | undefined;
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([{ ref: { id: 'echo', revision: '' }, role: 'status', text: filled ?? '' }]),
      locate: async () => [{ ref: { id: 'password', revision: '' }, role: 'textbox', states: { secure: true } }],
      actions: LOCATOR_ACTION_KINDS,
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

  it.each([
    ['1234', 'four characters'],
    ['🔐🔐🔐', 'three emoji, six UTF-16 units'],
  ])('refuses a provider value under 6 code points (%s, %s) at fill time with the unavailable code, pixels untainted', async (value) => {
    const screenshot = vi.fn(async () => 'screenshots/evidence.png');
    const { fixtures, config } = runtime(defineEngine({
      name: 'fake', version: '1', spiVersion: 1, artifacts: { screenshot },
    }), {
      credentials: { member: { username: 'ada', password: async () => value } },
    });
    setSecretRegistry(config);
    try {
      await expect(fixtures.screen.getByRole('textbox').fill(credentials.user('member').password)).rejects.toMatchObject({
        code: 'AUTH_CREDENTIAL_UNAVAILABLE',
        message: expect.stringContaining('at least 6 characters (code points)'),
      });
      await expect(fixtures.app.screenshot()).resolves.toBe('screenshots/evidence.png');
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
      observe: async () => snapshot([{ ref: { id: 'echo', revision: '' }, role: 'status', text: filled ?? '' }]),
      locate: async () => [{ ref: { id: 'key', revision: '' }, role: 'textbox', name: 'API key' }],
      actions: LOCATOR_ACTION_KINDS,
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

  it('fills a secret on a target without a site, such as a device whose URL is only a cache anchor', async () => {
    let filled: string | undefined;
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      app: {},
      observe: async () => snapshot([], { location: 'app://device/com.example.app/Sign%20In' }),
      locate: async () => [{ ref: { id: 'key', revision: '' }, role: 'textbox', name: 'API key' }],
      actions: LOCATOR_ACTION_KINDS,
      perform: async (_ref, action) => { if (action.kind === 'fill') filled = action.value; },
    });
    const { fixtures, config } = runtime(engine, { secrets: { key: 'sk_live_1' } });
    setSecretRegistry(config);
    try {
      await fixtures.screen.getByLabel('API key').fill(secrets.get('key'));
      expect(filled).toBe('sk_live_1');
    } finally {
      setSecretRegistry(undefined);
    }
  });

  it.each([
    ['the app origin', 'https://app.test/checkout'],
    ['another host on the app\'s site', 'https://auth.app.test/login'],
    ['a third-party sign-in page', 'https://accounts.idp.test/'],
  ])('a deterministic fill is not gated by origin: %s', async (_label, currentUrl) => {
    let filled: string | undefined;
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      app: { url: 'https://app.test' },
      observe: async () => snapshot([], { location: currentUrl }),
      locate: async () => [{ ref: { id: 'key', revision: '' }, role: 'textbox', name: 'API key' }],
      actions: LOCATOR_ACTION_KINDS,
      perform: async (_ref, action) => { if (action.kind === 'fill') filled = action.value; },
    });
    const { fixtures, config } = runtime(engine, { secrets: { key: 'sk_live_1' } });
    setSecretRegistry(config);
    try {
      await fixtures.screen.getByLabel('API key').fill(secrets.get('key'));
      expect(filled).toBe('sk_live_1');
    } finally {
      setSecretRegistry(undefined);
    }
  });

  it('fails a secret the config does not declare with SECRET_UNAVAILABLE', () => {
    const { config } = runtime(empty(), { secrets: { known: 'known-value' } });
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

  it('maps an EngineError a contributed method throws onto the runner taxonomy, and leaves other errors as thrown', async () => {
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      fixtures: {
        gadget: (context) => context.fixture('gadget', {
          async lost(): Promise<void> { throw new EngineError('INVALID_STATE', 'appstate requires an active session', { retryable: false }); },
          async slow(): Promise<void> { throw new EngineError('OPERATION_TIMEOUT', 'appstate timed out', { retryable: false }); },
          async denied(): Promise<void> { throw new TestError('POLICY_DENIED', 'no'); },
          async plain(): Promise<void> { throw new Error('plain failure'); },
        }, { lost: { kind: 'resource' }, slow: { kind: 'resource' }, denied: { kind: 'resource' }, plain: { kind: 'resource' } }),
      },
    });
    const { fixtures } = runtime(engine);
    const gadget = (fixtures as unknown as { gadget: Record<'lost' | 'slow' | 'denied' | 'plain', () => Promise<void>> }).gadget;
    await expect(gadget.lost()).rejects.toMatchObject({ code: 'APP_NOT_OPEN', category: 'test', message: 'appstate requires an active session' });
    await expect(gadget.slow()).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'operation timed out in gadget.slow' });
    await expect(gadget.denied()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(gadget.plain()).rejects.toThrow('plain failure');
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

describe('model reasoning on step events', () => {
  it('carries an act turn\'s reasoning onto its model event', async () => {
    const model = installFakeLoopModel(() => ({
      toolCalls: [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }],
      reasoning: 'The counter already reads 1; nothing left to do.',
    }));
    const { fixtures, steps } = runtime(empty(), { agents: { default: { executor: createAgent(), model } } });
    await fixtures.agent.act('check the counter');
    const event = steps.all().flatMap((step) => step.events).find((candidate) => candidate.kind === 'model');
    expect(event?.reasoning).toBe('The counter already reads 1; nothing left to do.');
  });

  it('carries a judgment call\'s reasoning onto its model event', async () => {
    const model = installFakeModel(() => judgment(true, 'the status reads 1'), {
      reasoning: 'The status node text is "1".',
    });
    const { fixtures, steps } = runtime(empty(), { agents: { default: { model } } });
    await fixtures.agent.assert('the status reads 1');
    const event = steps.all().flatMap((step) => step.events).find((candidate) => candidate.kind === 'model');
    expect(event?.reasoning).toBe('The status node text is "1".');
  });

  it('omits the field when the turn produced no reasoning', async () => {
    const model = installFakeLoopModel(() => ({
      toolCalls: [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }],
    }));
    const { fixtures, steps } = runtime(empty(), { agents: { default: { executor: createAgent(), model } } });
    await fixtures.agent.act('check the counter');
    const event = steps.all().flatMap((step) => step.events).find((candidate) => candidate.kind === 'model');
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty('reasoning');
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
      observe: async () => snapshot([{ ref: { id: 'button', revision: '' }, role: 'button' }]),
      actions: LOCATOR_ACTION_KINDS,
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
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([], { location: 'app://device/settings/general' }),
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
  });

  it("rejects a project tool that takes one of the agent's own tool names", () => {
    const tool = defineTool({ inputSchema: z.object({}), execute: async () => 'shadowed' }, { mutates: false });
    for (const name of ['screenshot', 'tap', 'observe', 'complete_step']) {
      expect(() => createAgent({ tools: { [name]: tool } })).toThrow(`the ${name} tool name is reserved`);
    }
  });
});

describe('press key grammar', () => {
  /** An engine that records every located expression and performed action. */
  function keyboard() {
    const locates: number[] = [];
    const performed: string[] = [];
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([{ ref: { id: 'field', revision: '' }, role: 'textbox', name: 'Name' }]),
      locate: async () => { locates.push(1); return [{ ref: { id: 'field', revision: '' }, role: 'textbox', name: 'Name' }]; },
      actions: ['tap', 'press'],
      perform: async (_ref, action) => { performed.push(action.kind === 'press' ? `press:${action.key}` : action.kind); },
    });
    return { engine, locates, performed };
  }

  it('rejects a key outside the grammar in the locator tier before the locator is resolved', async () => {
    const { engine, locates, performed } = keyboard();
    const { fixtures } = runtime(engine);
    for (const key of ['Ctrl+a', 'Enter+Shift', '', 'ab', 'Shift']) {
      await expect(fixtures.screen.getByLabel('Name').press(key)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining(`press key ${JSON.stringify(key)} is not a key`),
      });
    }
    expect(locates).toEqual([]);
    expect(performed).toEqual([]);
    await fixtures.screen.getByLabel('Name').press('Control+a');
    await fixtures.screen.getByLabel('Name').press('Shift++');
    expect(performed).toEqual(['press:Control+a', 'press:Shift++']);
  });

  it('rejects a key outside the grammar in the agent dispatcher before any engine call', async () => {
    const { engine, performed } = keyboard();
    let rejected: unknown;
    const { fixtures } = runtime(engine, { agents: { default: { executor: { name: 'test', async runStep(context) {
      await context.observe();
      try {
        await context.actions.press({ id: 'field' }, 'Ctrl+a');
      } catch (cause) {
        rejected = cause;
      }
      await context.actions.press({ id: 'field' }, 'Shift+Tab');
      return { status: 'passed', summary: 'pressed' };
    } } } } });
    await fixtures.agent.act('press keys');
    expect(rejected).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('"Ctrl+a" is not a key') });
    expect(performed).toEqual(['press:Shift+Tab']);
  });

  it('fails an undeclared action kind with UNSUPPORTED_CAPABILITY before the locator is resolved', async () => {
    const { engine, locates, performed } = keyboard();
    const { fixtures } = runtime(engine);
    await expect(fixtures.screen.getByLabel('Name').check()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'the "check" action is not available on this target: its engine declares tap, press',
    });
    await expect(fixtures.screen.swipe({ direction: 'down' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(locates).toEqual([]);
    expect(performed).toEqual([]);
  });
});

describe('app steering hooks', () => {
  function steerable(app: { url?: string }) {
    const calls: string[] = [];
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      app,
      observe: async () => snapshot([]),
      session: {
        open: async (url) => { calls.push(`open ${url}`); },
        restart: async () => { calls.push('restart'); },
        reset: async () => { calls.push('reset'); },
      },
    });
    return { engine, calls };
  }

  it('restart and clearState run the hook, then reopen the app at its base URL', async () => {
    const { engine, calls } = steerable({ url: 'http://127.0.0.1:4599' });
    const { fixtures, steps } = runtime(engine);
    await fixtures.app.restart();
    await fixtures.app.clearState();
    expect(calls).toEqual(['restart', 'open http://127.0.0.1:4599/', 'reset', 'open http://127.0.0.1:4599/']);
    expect(steps.all().map((step) => step.api)).toEqual(['app.restart', 'app.clearState']);
  });

  it('reopen nothing on a surface without an address', async () => {
    const { engine, calls } = steerable({});
    const { fixtures } = runtime(engine);
    await fixtures.app.restart();
    await fixtures.app.clearState();
    expect(calls).toEqual(['restart', 'reset']);
  });

  /** A device: no address, no `open`, a pinned app `restart` launches fresh. */
  function device(pinned = true) {
    const calls: string[] = [];
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([]),
      session: pinned ? { restart: async () => { calls.push('restart'); } } : {},
    });
    return { engine, calls };
  }

  it('app.open() on a device launches the pinned app fresh through restart, as one app.open step', async () => {
    const { engine, calls } = device();
    const { fixtures, steps } = runtime(engine);
    await fixtures.app.open();
    expect(calls).toEqual(['restart']);
    expect(steps.all().map((step) => [step.api, step.status])).toEqual([['app.open', 'passed']]);
  });

  it('app.open(path) on a device is APP_URL_REQUIRED and names device.openLink', async () => {
    const { engine, calls } = device();
    const { fixtures } = runtime(engine);
    await expect(fixtures.app.open('/orders')).rejects.toMatchObject({
      code: 'APP_URL_REQUIRED',
      message: expect.stringContaining('device.openLink'),
    });
    expect(calls).toEqual([]);
  });

  it('app.open() on a device without a pinned app is UNSUPPORTED_CAPABILITY and names the app option', async () => {
    const { engine } = device(false);
    const { fixtures } = runtime(engine);
    await expect(fixtures.app.open()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('appPath'),
    });
  });
});

describe('check and uncheck options', () => {
  function toggle() {
    const performed: string[] = [];
    const node = { ref: { id: 'agree', revision: '' }, role: 'checkbox', name: 'Agree' };
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([node]),
      locate: async () => [node],
      actions: ['check', 'uncheck'],
      perform: async (_ref, action) => { performed.push(action.kind); },
    });
    return { engine, performed };
  }

  it.each(['check', 'uncheck'] as const)('%s rejects an unknown option before any engine call or step', (api) => {
    const { engine, performed } = toggle();
    const { fixtures, steps } = runtime(engine);
    expect(() => fixtures.screen.getByLabel('Agree')[api]({ trial: true } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: `${api} options has no key "trial"; it takes timeout` }),
    );
    expect(performed).toEqual([]);
    expect(steps.all()).toEqual([]);
  });

  it('checks and unchecks with a timeout or no options', async () => {
    const { engine, performed } = toggle();
    const { fixtures, steps } = runtime(engine);
    await fixtures.screen.getByLabel('Agree').check();
    await fixtures.screen.getByLabel('Agree').uncheck({ timeout: 1_000 });
    expect(performed).toEqual(['check', 'uncheck']);
    expect(steps.all().map((step) => step.api)).toEqual(['locator.check', 'locator.uncheck']);
  });
});

describe('coordinate input', () => {
  const box = { x: 100, y: 200, width: 50, height: 20 };
  function pointer(options: { rect?: false; hidden?: true; scrollIntoView?: false } = {}) {
    const performed: string[] = [];
    const performedAt: string[] = [];
    const locates: number[] = [];
    const node = {
      ref: { id: 'pad', revision: '' }, role: 'img', name: 'Pad',
      ...(options.rect === false ? {} : { rect: box }),
      ...(options.hidden === true ? { states: { hidden: true } } : {}),
    };
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([node]),
      locate: async () => { locates.push(1); return [node]; },
      actions: options.scrollIntoView === false ? ['tap'] : ['tap', 'scrollIntoView'],
      perform: async (_ref, action) => { performed.push(action.kind); },
      pointerActions: ['tap', 'swipeTo'],
      performAt: async (point, action) => {
        const path = action.kind === 'swipeTo' ? ` -> ${action.target.x},${action.target.y}` : '';
        performedAt.push(`${action.kind} @ ${point.x},${point.y}${path}`);
      },
    });
    return { engine, performed, performedAt, locates };
  }

  it('screen.tapAt dispatches a pointer tap at the viewport point, with no locate, and records the step', async () => {
    const { engine, performedAt, locates } = pointer();
    const { fixtures, steps } = runtime(engine);
    await fixtures.screen.tapAt({ x: 12.5, y: 40 });
    expect(performedAt).toEqual(['tap @ 12.5,40']);
    expect(locates).toEqual([]);
    expect(steps.all().at(-1)).toMatchObject({ kind: 'screen', api: 'screen.tapAt', label: '(12.5, 40)', status: 'passed' });
  });

  it('rejects a point off the plane and an unknown option before any engine call', async () => {
    const { engine, performedAt } = pointer();
    const { fixtures } = runtime(engine);
    for (const point of [{ x: Number.NaN, y: 1 }, { x: Number.POSITIVE_INFINITY, y: 1 }, { x: 1 }, { x: '1', y: 2 }, undefined]) {
      await expect(fixtures.screen.tapAt(point as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', message: 'tapAt requires a point { x, y } of finite numbers',
      });
    }
    await expect(fixtures.screen.tapAt({ x: -1, y: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', message: 'tapAt requires a point { x, y } of non-negative numbers',
    });
    await expect(fixtures.screen.tapAt({ x: 1, y: 1 }, { force: true } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(() => fixtures.screen.getByLabel('Pad').tap({ position: { x: -1, y: 0 } })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'tap position requires a point { x, y } of non-negative numbers' }),
    );
    expect(performedAt).toEqual([]);
  });

  it('fails UNSUPPORTED_CAPABILITY without a pointer tap, before the locator is resolved', async () => {
    const locates: number[] = [];
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      observe: async () => snapshot([]),
      locate: async () => { locates.push(1); return [{ ref: { id: 'pad', revision: '' }, role: 'img', name: 'Pad', rect: box }]; },
      actions: ['tap'],
      perform: async () => undefined,
    });
    const { fixtures } = runtime(engine);
    const unsupported = {
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'the "tap" action at a point is not available on this target: its engine declares no pointer actions',
    };
    await expect(fixtures.screen.tapAt({ x: 1, y: 1 })).rejects.toMatchObject(unsupported);
    await expect(fixtures.screen.getByLabel('Pad').tap({ position: { x: 1, y: 1 } })).rejects.toMatchObject(unsupported);
    await expect(fixtures.screen.swipe({ from: { x: 1, y: 1 }, to: { x: 1, y: 9 } })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('the "swipeTo" action at a point'),
    });
    expect(locates).toEqual([]);
    await fixtures.screen.getByLabel('Pad').tap();
    expect(locates).toEqual([1]);
  });

  it('locator.tap({ position }) scrolls the node into view, then taps the pointer at the offset of its box', async () => {
    const { engine, performed, performedAt } = pointer();
    const { fixtures, steps } = runtime(engine);
    await fixtures.screen.getByLabel('Pad').tap({ position: { x: 5, y: 7 } });
    expect(performed).toEqual(['scrollIntoView']);
    expect(performedAt).toEqual(['tap @ 105,207']);
    expect(steps.all().at(-1)).toMatchObject({
      kind: 'locator', api: 'locator.tap', label: expect.stringMatching(/ at \(5, 7\)$/), status: 'passed',
    });
    await fixtures.screen.getByLabel('Pad').click({ position: { x: 50, y: 20 } });
    expect(performedAt).toEqual(['tap @ 105,207', 'tap @ 150,220']);
    expect(steps.all().map((step) => step.api)).toEqual(['locator.tap', 'locator.click']);
    await fixtures.screen.getByLabel('Pad').tap();
    expect(performed).toEqual(['scrollIntoView', 'scrollIntoView', 'tap']);
  });

  it('taps at the offset straight from the box when the engine cannot scroll into view', async () => {
    const { engine, performed, performedAt } = pointer({ scrollIntoView: false });
    const { fixtures } = runtime(engine);
    await fixtures.screen.getByLabel('Pad').tap({ position: { x: 5, y: 7 } });
    expect(performed).toEqual([]);
    expect(performedAt).toEqual(['tap @ 105,207']);
  });

  it.each([
    ['hidden', { hidden: true }],
    ['has no box', { rect: false }],
  ] as const)('waits for a node that is %s and fails LOCATOR_NOT_FOUND at the deadline', async (_case, options) => {
    const { engine, performedAt } = pointer(options);
    const { fixtures } = runtime(engine);
    await expect(fixtures.screen.getByLabel('Pad').tap({ position: { x: 1, y: 1 }, timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('did not become visible with a box'),
      details: expect.objectContaining({ waitedMs: expect.any(Number) }),
    });
    expect(performedAt).toEqual([]);
  });

  it('screen.swipe({ from, to }) dispatches a pointer swipe along the path; a direction still needs the swipe action', async () => {
    const { engine, performedAt } = pointer();
    const { fixtures, steps } = runtime(engine);
    await fixtures.screen.swipe({ from: { x: 10, y: 20 }, to: { x: 10, y: 300 } });
    expect(performedAt).toEqual(['swipeTo @ 10,20 -> 10,300']);
    expect(steps.all().at(-1)).toMatchObject({ kind: 'screen', api: 'screen.swipe', label: '(10, 20) → (10, 300)', status: 'passed' });
    await expect(fixtures.screen.swipe({ direction: 'up', to: { x: 1, y: 1 } } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', message: expect.stringContaining('swipe options has no key "direction"'),
    });
    await expect(fixtures.screen.swipe({ from: { x: 1, y: 1 } } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', message: 'swipe to requires a point { x, y } of finite numbers',
    });
    await expect(fixtures.screen.swipe({ direction: 'up' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(performedAt).toEqual(['swipeTo @ 10,20 -> 10,300']);
  });
});

describe('assert evidence under a custom executor', () => {
  const judging: StepExecutor = {
    name: 'judging',
    version: '1',
    runStep: async () => ({ status: 'passed', summary: 'holds' }),
  };
  const engineWith = (screenshot: () => Promise<string>) =>
    defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]), artifacts: { screenshot } });

  it('attaches the screenshot the engine delivers after the verdict', async () => {
    const screenshot = vi.fn(async () => 'screenshots/assert.png');
    const { fixtures, steps, registerArtifact } = runtime(engineWith(screenshot), { agents: { default: judging } });
    await fixtures.agent.assert('the screen holds');
    expect(screenshot).toHaveBeenCalledExactlyOnceWith('assert', expect.objectContaining({ origin: 'agent' }));
    expect(registerArtifact).toHaveBeenCalledExactlyOnceWith('screenshot', 'screenshots/assert.png');
    expect(steps.all().at(-1)).toMatchObject({ api: 'agent.assert', status: 'passed', artifacts: ['artifact'] });
  });

  it('abandons a screenshot the engine never delivers at the operation budget, not the step timeout, and keeps the verdict', async () => {
    vi.useFakeTimers();
    try {
      const screenshot = vi.fn(() => new Promise<never>(() => {}));
      const { fixtures, steps, registerArtifact } = runtime(engineWith(screenshot), {
        agents: { default: judging },
        actionTimeout: 200,
      });
      let settled = false;
      const asserting = fixtures.agent.assert('the screen holds', { timeout: 2_000 }).then(() => {
        settled = true;
      });
      // The capture is bounded by the operation budget: actionTimeout, capped by the step clock.
      await vi.advanceTimersByTimeAsync(199);
      expect(screenshot).toHaveBeenCalledExactlyOnceWith('assert', expect.objectContaining({ origin: 'agent', timeoutMs: 200 }));
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await asserting;
      expect(registerArtifact).not.toHaveBeenCalled();
      expect(steps.all().at(-1)).toMatchObject({ api: 'agent.assert', status: 'passed', artifacts: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
