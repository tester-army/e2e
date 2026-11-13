/**
 * Engine targets: a target whose surface is a
 * defineEngine body. Covers the full pipeline — config, worker, adapter,
 * executor socket, lifecycle, capability gating, and the report — with a toy
 * in-memory engine and a hand-rolled executor, no model and no browser.
 */

import { describe, expect, it } from 'vitest';
import { defineEngine } from 'e2e-core/lib/engine/index';
import type { StepExecutor } from 'e2e-core/lib/agent/executor';
import type { SemanticNode } from 'e2e-core/lib/engine/surface';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runProjectWithConfigFile } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const builtRunnerModule = new URL('../../dist/run/runner.js', import.meta.url).href;
const { run } = (await import(builtRunnerModule)) as typeof import('../../src/run/runner.ts');

const SUITE = `import { test } from 'e2e';

test('agent drives the toy device', async ({ agent }) => {
  await agent.act('increment the counter to 2');
});
`;

const SCREEN_SUITE = `import { test, expect } from 'e2e';

test('screen is unavailable on an engine without location', async ({ screen }) => {
  await expect(screen.getByRole('button')).toBeVisible();
});
`;

const DETERMINISTIC_SUITE = `import { test, expect } from 'e2e';

test('screen and expect drive the toy device over locate', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

const WORKER_LOG_SUITE = `import { test, expect } from 'e2e';

test('the button is there', async ({ screen }) => {
  await expect(screen.getByRole('button', { name: 'Go' })).toBeVisible();
});
`;

/** An engine in a config file, so the runner spawns a worker process and the init line crosses IPC. */
const WORKER_LOG_CONFIG = `import type { E2EConfig } from 'e2e';
import { defineEngine } from 'e2e/engine';

const node = { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go', states: { hidden: false } };

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'hosted', platform: 'ios', engine: defineEngine({
    name: 'hosted-fake',
    version: '1.0.0',
    spiVersion: 1,
    async init(info) { info.log('watch live at https://example.test/sessions/abc'); },
    async observe() { return { location: 'app://fake/Home', root: node, viewport: { width: 1280, height: 720 } }; },
    async locate() { return [node]; },
  }) }],
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;

/** A two-node screen: a counter value and a button that increments it. */
function toyEngine(
  options: {
    withLocate?: boolean;
    withoutInit?: boolean;
    withPrepare?: 'ok' | 'fail' | 'hang-finish';
  } = {},
) {
  const lifecycle: string[] = [];
  let initEnv: Record<string, string | undefined> = {};
  let count = 0;
  const nodes = (): SemanticNode[] => [
    { ref: { id: 'counter', revision: '' }, role: 'status', name: 'count', text: String(count) },
    { ref: { id: 'increment', revision: '' }, role: 'button', name: 'Increment' },
  ];
  const engine = defineEngine({
    name: 'toy-device',
    version: '1.0.0',
    spiVersion: 1,
    ...(options.withPrepare === undefined
      ? {}
      : {
          async prepare(info: { env: NodeJS.ProcessEnv; log: (line: string) => void }) {
            lifecycle.push('prepare');
            info.log(`provisioning toy device for ${info.env['TOY_CACHE'] ?? 'no cache'}`);
            if (options.withPrepare === 'fail') throw new Error('toolchain missing');
            // Long enough that a clock started after this hook is measurably
            // later than the notice it just logged.
            await new Promise((resolve) => setTimeout(resolve, 50));
            // What prepare provisioned reaches the workers through the
            // result's env; the run's own variables are never overwritten.
            return { env: { TOY_POOL: 'sim-a,sim-b', TOY_CACHE: '/overwritten' } };
          },
          // Releases what prepare acquired: after the last worker, on every exit path.
          async finish(info: { env: NodeJS.ProcessEnv; signal: AbortSignal; log: (line: string) => void }) {
            lifecycle.push('finish');
            if (options.withPrepare === 'hang-finish') {
              // Ignores its signal on purpose: the runner must not wait on it.
              await new Promise(() => undefined);
            }
            info.log(`releasing toy device for ${info.env['TOY_CACHE'] ?? 'no cache'}`);
          },
        }),
    ...(options.withoutInit === true
      ? {}
      : {
          async init(info: { env: Readonly<Record<string, string | undefined>>; log: (line: string) => void }) {
            lifecycle.push('init');
            initEnv = { TOY_POOL: info.env['TOY_POOL'], TOY_CACHE: info.env['TOY_CACHE'] };
            // A fact that only exists once the worker is up: which device the slot got.
            info.log(`booted ${info.env['TOY_POOL']?.split(',')[0] ?? 'no device'}`);
          },
        }),
    async dispose() {
      lifecycle.push('dispose');
    },
    async observe() {
      return snapshot(nodes());
    },
    actions: ['tap', 'fill', 'press', 'selectOption'],
    async perform(ref, action) {
      if (ref.id !== 'increment' || action.kind !== 'tap') {
        throw new Error(`cannot ${action.kind} node ${ref.id}`);
      }
      count += 1;
    },
    ...(options.withLocate !== true
      ? {}
      : {
          async locate(expression) {
            // Toy resolution: match by role, and by name when the query has one.
            if (expression.kind !== 'query') return [];
            const value = expression.query.value;
            const role =
              expression.query.kind === 'role' && value.kind === 'string' ? value.value : undefined;
            const name =
              expression.query.name?.kind === 'string' ? expression.query.name.value : undefined;
            return nodes().filter(
              (node) =>
                (role === undefined || node.role === role) &&
                (name === undefined || node.name === name),
            );
          },
        }),
  });
  return { initEnv: () => initEnv, engine, lifecycle, current: () => count };
}

/** Observes, taps until the counter reads the goal, verifies, concludes. */
const tapper: StepExecutor = {
  name: 'toy-tapper',
  version: '1',
  async runStep(context) {
    // The executor is told exactly which grammar the surface honors: perform
    // gives tap/type/press/select, and this toy has no swipe, navigate, or
    // bare-point tap.
    const verbs = [...context.target.verbs].toSorted();
    if (context.target.platform !== 'ios' || verbs.join() !== 'press,select,tap,type,typeSecret') {
      return { status: 'failed', summary: `unexpected target ${context.target.platform} ${verbs.join()}` };
    }
    for (let round = 0; round < 5; round += 1) {
      const observation = await context.observe();
      const match = /#counter status "count" text="(\d+)"/.exec(observation.text);
      const value = Number(match?.[1] ?? Number.NaN);
      if (value === 2) {
        return { status: 'passed', summary: `counter reached 2 after ${round} taps` };
      }
      await context.actions.tap({ id: 'increment' });
    }
    return { status: 'failed', summary: 'counter never reached 2' };
  },
};

describe('engine targets', () => {
  it('runs an agent step over the adapter, with lifecycle and honest provenance', async () => {
    const toy = toyEngine();
    const project = createProject({ 'tests/toy.e2e.ts': SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          agents: { default: { executor: tapper, maxModelCalls: 10 } },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.current()).toBe(2);
      expect(toy.lifecycle).toEqual(['init', 'dispose']);
      const reportTarget = outcome.report.run.targets.find((entry) => entry.id === 'toy-sim');
      expect(reportTarget?.engine.name).toBe('toy-device');
      expect(reportTarget?.platform).toBe('ios');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('fails a screen test loud with UNSUPPORTED_CAPABILITY', async () => {
    const toy = toyEngine();
    const project = createProject({ 'tests/screen.e2e.ts': SCREEN_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          agents: { default: { executor: tapper } },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.results[0]?.attempts.at(-1)?.error).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', category: 'configuration' });
    } finally {
      project.cleanup();
    }
  });

  it('disposes an engine that declares no init', async () => {
    const toy = toyEngine({ withLocate: true, withoutInit: true });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      // Worker-end disposal is unconditional: resources acquired lazily, with
      // no init hook to gate on, are still released.
      expect(toy.lifecycle).toEqual(['dispose']);
    } finally {
      project.cleanup();
    }
  });

  it('prepares an engine once in the runner as a setup step before the plan, narrating through notice events', async () => {
    const toy = toyEngine({ withLocate: true, withPrepare: 'ok' });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    const notices: { target: string; message: string }[] = [];
    const setup: { kind: string; state: string; engine?: string; durationMs?: number }[] = [];
    /** Event types in order of first appearance. */
    const order: string[] = [];
    /** Every event type in sequence, notices with their message. */
    const sequence: string[] = [];
    let noticeAt = 0;
    const env: NodeJS.ProcessEnv = { ...process.env, APP_URL: '', CI: '', TOY_CACHE: '/run/cache' };
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          cache: 'off',
        },
        env,
        quiet: true,
        onEvent: (event) => {
          if (!order.includes(event.type)) order.push(event.type);
          sequence.push(event.type === 'notice' ? `notice:${event.message}` : event.type);
          if (event.type === 'notice') {
            notices.push({ target: event.target, message: event.message });
            // The prepare notice; finish narrates after the clock, and is not what startedAt is measured against.
            if (noticeAt === 0) noticeAt = Date.parse(event.at);
          }
          if (event.type === 'setup') {
            setup.push({
              kind: event.step.kind,
              state: event.state,
              ...(event.step.kind === 'prepare' ? { engine: event.step.engine } : {}),
              ...(event.state === 'finished' ? { durationMs: event.durationMs } : {}),
            });
          }
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.lifecycle).toEqual(['prepare', 'init', 'dispose', 'finish']);
      // Both hooks see the run's environment, the one the workers start with.
      // The worker's init line arrives as the same event, naming the target
      // and slot, since nothing else does once the run is executing.
      expect(notices).toEqual([
        { target: 'toy-sim', message: 'provisioning toy device for /run/cache' },
        { target: 'toy-sim', message: 'toy-sim worker 0: booted sim-a' },
        { target: 'toy-sim', message: 'releasing toy device for /run/cache' },
      ]);
      expect(sequence.indexOf('notice:toy-sim worker 0: booted sim-a')).toBeGreaterThan(sequence.indexOf('plan'));
      // The result's env reached init as the worker's environment; the run's own value won.
      expect(toy.initEnv()).toEqual({ TOY_POOL: 'sim-a,sim-b', TOY_CACHE: '/run/cache' });
      expect(env['TOY_POOL']).toBeUndefined();
      // Collection and provisioning are setup steps between the header and
      // the plan; the notice narrates under the prepare step, which names the
      // engine and lasts at least the hook's own wait.
      expect(order.slice(0, 5)).toEqual(['run-started', 'setup', 'notice', 'plan', 'test-started']);
      expect(setup.map((step) => `${step.kind}:${step.state}`)).toEqual([
        'collect:started',
        'collect:finished',
        'prepare:started',
        'prepare:finished',
      ]);
      const prepared = setup[3]!;
      expect(prepared.engine).toBe('toy-device');
      expect(prepared.durationMs).toBeGreaterThanOrEqual(40);
      // The clock starts with the plan: the report's startedAt is later than
      // the download it narrated (with a margin for a timer firing early).
      expect(Date.parse(outcome.report.run.startedAt)).toBeGreaterThanOrEqual(noticeAt + 40);
    } finally {
      project.cleanup();
    }
  });

  it('streams an init log line from a worker process as a notice naming the target and slot', async () => {
    const notices: { target: string; message: string }[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/go.e2e.ts': WORKER_LOG_SUITE },
      {
        appUrl: '',
        configSource: WORKER_LOG_CONFIG,
        runOptions: {
          onEvent: (event) => {
            if (event.type === 'notice') notices.push({ target: event.target, message: event.message });
          },
        },
      },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      expect(notices).toEqual([{ target: 'hosted', message: 'hosted worker 0: watch live at https://example.test/sessions/abc' }]);
    } finally {
      project.cleanup();
    }
  });

  it('ends the run before any worker starts when prepare fails', async () => {
    const toy = toyEngine({ withLocate: true, withPrepare: 'fail' });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    const errors: { message: string; phase: string | undefined }[] = [];
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
        onEvent: (event) => {
          if (event.type === 'run-error') {
            errors.push({ message: event.error.message, phase: event.error.phase });
          }
        },
      });
      expect(outcome.status).toBe('error');
      expect(outcome.results).toEqual([]);
      // No worker ever booted: nothing to init, nothing to dispose. What the
      // failed prepare may have acquired is still released.
      expect(toy.lifecycle).toEqual(['prepare', 'finish']);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('toolchain missing');
      expect(errors[0]?.phase).toBe('launch');
    } finally {
      project.cleanup();
    }
  });

  it('abandons a finish hook that outlives the cleanup budget as a cleanup error instead of hanging the run', async () => {
    const toy = toyEngine({ withLocate: true, withPrepare: 'hang-finish' });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    const errors: { code: string; phase: string | undefined }[] = [];
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', engine: toy.engine }],
          cache: 'off',
          cleanupTimeout: 300,
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
        onEvent: (event) => {
          if (event.type === 'run-error') errors.push({ code: event.error.code, phase: event.error.phase });
        },
      });
      // The tests ran and passed; only the teardown is in error, and the run still reported.
      expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
      expect(toy.lifecycle).toEqual(['prepare', 'init', 'dispose', 'finish']);
      expect(errors).toEqual([{ code: 'CLEANUP_TIMEOUT', phase: 'cleanup' }]);
    } finally {
      project.cleanup();
    }
  });
});
