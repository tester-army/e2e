/**
 * Backend targets (RFC0002): a target whose surface is a
 * defineBackend body. Covers the full pipeline — config, worker, adapter,
 * executor socket, lifecycle, capability gating, and the report — with a toy
 * in-memory backend and a hand-rolled executor, no model and no browser.
 */

import { describe, expect, it } from 'vitest';
import { defineBackend, type BackendFixtureContext } from '../../src/backend/index.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { SemanticNode } from '../../src/backend/surface.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject } from '../helpers/run-project.ts';

const builtRunnerModule = new URL('../../dist/run/runner.js', import.meta.url).href;
const { run } = (await import(builtRunnerModule)) as typeof import('../../src/run/runner.ts');

const SUITE = `import { test } from 'e2e';

test('agent drives the toy device', async ({ agent }) => {
  await agent.act('increment the counter to 2');
});
`;

const SCREEN_SUITE = `import { test, expect } from 'e2e';

test('screen is unavailable on a backend without location', async ({ screen }) => {
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

const FIXTURE_SUITE = `import { test, expect } from 'e2e';

test('a contributed fixture runs with harness discipline', async (fixtures) => {
  const device = (fixtures as unknown as { device: { reset(): Promise<string>; shake(): Promise<string> } }).device;
  await expect(await device.reset()).toBe('reset-done');
  await expect(await device.shake()).toBe('shaken');
});
`;

const STATE_SUITE = `import { test, expect } from 'e2e';

test.setup('seed the counter', { sessions: ['seeded'] }, async ({ screen, session }) => {
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await session.save('seeded');
});

test('restores the seeded counter', { session: 'seeded' }, async ({ screen }) => {
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;


/** A two-node screen: a counter value and a button that increments it. */
function toyBackend(
  options: {
    withLocate?: boolean;
    withFixtures?: boolean;
    withState?: boolean;
    withIsolation?: boolean;
    withoutInit?: boolean;
  } = {},
) {
  const lifecycle: string[] = [];
  const fixtureCalls: string[] = [];
  let count = 0;
  const nodes = (): SemanticNode[] => [
    { ref: { id: 'counter', revision: '' }, role: 'status', name: 'count', text: String(count) },
    { ref: { id: 'increment', revision: '' }, role: 'button', name: 'Increment' },
  ];
  const backend = defineBackend({
    name: 'toy-device',
    spiVersion: 1,
    ...(options.withoutInit === true
      ? {}
      : {
          async init() {
            lifecycle.push('init');
          },
        }),
    ...(options.withIsolation !== true
      ? {}
      : {
          async startAttempt(context: { attemptId: string; artifactsDir: string }) {
            lifecycle.push(`startAttempt:${context.artifactsDir.length > 0 ? 'dir' : 'nodir'}`);
            count = 0;
          },
          async endAttempt() {
            lifecycle.push('endAttempt');
          },
        }),
    async dispose() {
      lifecycle.push('dispose');
    },
    async observe() {
      return { nodes: nodes() };
    },
    actions: {
      async tap(target) {
        if (target.ref.id !== 'increment') throw new Error(`no such node ${target.ref.id}`);
        count += 1;
      },
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
    ...(options.withFixtures !== true
      ? {}
      : {
          fixtures: {
            device: (context: BackendFixtureContext) => ({
              async reset() {
                fixtureCalls.push(`reset:${context.targetName}`);
                count = 0;
                return 'reset-done';
              },
              async shake() {
                fixtureCalls.push('shake');
                return 'shaken';
              },
            }),
          },
        }),
    ...(options.withState !== true
      ? {}
      : {
          state: {
            async capture() {
              return { format: 'toy', version: 1, data: { count } };
            },
            async restore(snapshot: { data: unknown }) {
              count = (snapshot.data as { count: number }).count;
            },
          },
        }),
  });
  return { backend, lifecycle, fixtureCalls, current: () => count };
}

/** Observes, taps until the counter reads the goal, verifies, concludes. */
const tapper: StepExecutor = {
  name: 'toy-tapper',
  version: '1',
  async runStep(context) {
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

describe('backend targets', () => {
  it('runs an agent step over the adapter, with lifecycle and honest provenance', async () => {
    const toy = toyBackend();
    const project = createProject({ 'tests/toy.e2e.ts': SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          agent: { executor: tapper, maxModelCalls: 10 },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.current()).toBe(2);
      expect(toy.lifecycle).toEqual(['init', 'dispose']);
      const reportTarget = outcome.report.run.targets.find((entry) => entry.id === 'toy-sim');
      expect(reportTarget?.backend.name).toBe('toy-device');
      expect(reportTarget?.platform).toBe('ios');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('fails a screen test loud with UNSUPPORTED_CAPABILITY', async () => {
    const toy = toyBackend();
    const project = createProject({ 'tests/screen.e2e.ts': SCREEN_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          agent: { executor: tapper },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).not.toBe(0);
      const result = outcome.results[0];
      const message = result?.attempts.at(-1)?.error?.message ?? '';
      expect(message).toMatch(/no backend capability|UNSUPPORTED/i);
    } finally {
      project.cleanup();
    }
  });

  it('runs the deterministic screen/expect tier over backend.locate', async () => {
    const toy = toyBackend({ withLocate: true });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.current()).toBe(2);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('runs a contributed fixture with harness step discipline', async () => {
    const toy = toyBackend({ withFixtures: true });
    const project = createProject({ 'tests/fixture.e2e.ts': FIXTURE_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.exitCode).toBe(0);
      expect(toy.fixtureCalls).toEqual(['reset:toy-sim', 'shake']);
      // Every contributed call is a recorded step, named <fixture>.<method>.
      const steps = outcome.results[0]?.attempts[0]?.steps ?? [];
      const names = steps.map((step) => step.api);
      expect(names).toContain('device.reset');
      expect(names).toContain('device.shake');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('captures and restores opaque backend state across a session', async () => {
    const toy = toyBackend({ withLocate: true, withState: true });
    const project = createProject({ 'tests/state.e2e.ts': STATE_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });


  it('resets per-attempt state via startAttempt/endAttempt isolation', async () => {
    const toy = toyBackend({ withLocate: true, withIsolation: true });
    const suite = `import { test, expect } from 'e2e';

test('first attempt starts fresh', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('second attempt also starts fresh', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;
    const project = createProject({ 'tests/iso.e2e.ts': suite });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.lifecycle.filter((e) => e.startsWith('startAttempt'))).toEqual([
        'startAttempt:dir',
        'startAttempt:dir',
      ]);
      expect(toy.lifecycle.filter((e) => e === 'endAttempt')).toHaveLength(2);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('disposes a backend that declares no init', async () => {
    const toy = toyBackend({ withLocate: true, withoutInit: true });
    const project = createProject({ 'tests/screen.e2e.ts': DETERMINISTIC_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
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

  it('gates an undeclared fixture at selection via requires', async () => {
    const toy = toyBackend(); // no fixtures declared
    const project = createProject({
      'tests/req.e2e.ts': `import { test } from 'e2e';

test('needs device', { requires: ['device'] }, async () => {});
`,
    });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
        passWithNoTests: true,
      });
      const result = outcome.results[0];
      expect(result?.status).toBe('skipped');
      expect(result?.skip?.cause).toBe('capability-unavailable');
    } finally {
      project.cleanup();
    }
  });
});
