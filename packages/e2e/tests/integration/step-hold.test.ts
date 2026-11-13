/**
 * `RunOptions.beforeStep`, the seam behind `e2e run --step`, through real
 * worker processes: which steps wait, that held time is charged to nothing,
 * and how a hold ends when its step can no longer run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HeldStep, StepHoldContext } from '../../src/run/step-hold.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds every step whose label holds `slow` for `ms`, and lets the rest through at once; records what it saw. */
function holder(ms: number): { held: HeldStep[]; beforeStep: (step: HeldStep, context: StepHoldContext) => Promise<void> } {
  const held: HeldStep[] = [];
  return {
    held,
    beforeStep: async (step) => {
      held.push(step);
      if (step.label.includes('slow')) await sleep(ms);
    },
  };
}

const TIMEOUT_MS = 800;
const HOLD_MS = 1_500;

const HELD_SUITE = `import { test, expect } from 'e2e';

test('waits past its timeout at holds and still passes', async ({ app }) => {
  await app.open('/slow-1');
  await app.open('/slow-2');
});

test('times out on the budget a hold left', async ({ app }) => {
  await app.open('/slow-3');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});

test('holds steps started together in call order', async ({ app }) => {
  await Promise.all([app.open('/together-a'), app.open('/together-b')]);
});

test('never holds a step inside a poll read', async ({ app }) => {
  await expect.poll(async () => { await app.open('/in-poll'); return 1; }).toBe(1);
});

const tries = globalThis as { retried?: number };
test('never holds a retry', async ({ app }) => {
  await app.open('/retry');
  tries.retried = (tries.retried ?? 0) + 1;
  if (tries.retried === 1) throw new Error('first attempt fails');
});
`;

const HOOKS_SUITE = `import { test } from 'e2e';

test.setup('seeds a session', { sessions: ['seeded'] }, async ({ app, session }) => {
  await app.open('/setup');
  await session.save('seeded');
});

test.beforeEach(async ({ app }) => { await app.open('/before-each'); });
test.afterEach(async ({ app }) => { await app.open('/after-each'); });

test('holds beforeEach and body steps, never teardown', { session: 'seeded' }, async ({ app }) => {
  await app.open('/body');
});
`;

describe('beforeStep on the worker path', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  const { held, beforeStep } = holder(HOLD_MS);

  beforeAll(async () => {
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/held.e2e.ts': HELD_SUITE, 'tests/hooks.e2e.ts': HOOKS_SUITE },
      { configSource: workerFakeConfigSource(1, `\n  timeout: ${TIMEOUT_MS},\n  retries: 1,`), runOptions: { beforeStep } },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  const labels = (): string[] => held.map((step) => step.label);

  it('stops the test clock while a step is held, and keeps the wait out of the step', () => {
    const result = resultByTitle(outcome, 'waits past its timeout at holds and still passes');
    expect(result.status).toBe('passed');
    const steps = result.attempts[0]?.steps ?? [];
    expect(steps.map((step) => step.label)).toEqual(['/slow-1', '/slow-2']);
    for (const step of steps) expect(step.durationMs).toBeLessThan(HOLD_MS);
  });

  it('times a test out on the budget it had left when the hold ended', () => {
    const result = resultByTitle(outcome, 'times out on the budget a hold left');
    expect(result.status).toBe('timed-out');
    const duration = result.attempts[0]?.durationMs ?? 0;
    expect(duration).toBeGreaterThanOrEqual(HOLD_MS + TIMEOUT_MS - 100);
    expect(duration).toBeLessThan(5_000);
  });

  it('holds steps started together one at a time and records them in call order', () => {
    expect(labels().filter((label) => label.startsWith('/together'))).toEqual(['/together-a', '/together-b']);
    const steps = resultByTitle(outcome, 'holds steps started together in call order').attempts[0]?.steps ?? [];
    expect(steps.map((step) => [step.index, step.label])).toEqual([[0, '/together-a'], [1, '/together-b']]);
  });

  it('never holds a step an expect.poll read calls', () => {
    expect(resultByTitle(outcome, 'never holds a step inside a poll read').status).toBe('passed');
    expect(labels()).not.toContain('/in-poll');
  });

  it('holds the first attempt only, never a retry', () => {
    expect(resultByTitle(outcome, 'never holds a retry').status).toBe('flaky');
    expect(labels().filter((label) => label === '/retry')).toHaveLength(1);
  });

  it('holds beforeEach and body steps, never a setup test or teardown', () => {
    expect(resultByTitle(outcome, 'holds beforeEach and body steps, never teardown').status).toBe('passed');
    expect(labels()).toEqual(expect.arrayContaining(['/before-each', '/body']));
    expect(labels()).not.toContain('/setup');
    expect(labels()).not.toContain('/after-each');
  });

  it('names the test each held step belongs to', () => {
    expect(held.find((step) => step.label === '/body')).toMatchObject({
      target: 'fake',
      title: 'holds beforeEach and body steps, never teardown',
      api: 'app.open',
      source: { file: 'tests/hooks.e2e.ts' },
    });
  });

  it('reads no screen unless the run asks for held screens', () => {
    expect(held.filter((step) => step.screen !== undefined)).toEqual([]);
  });
});

describe('beforeStep and the run limits', () => {
  it('stops the time limit while a step is held', async () => {
    const { beforeStep } = holder(3_000);
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/limit.e2e.ts': `import { test } from 'e2e';\ntest('outlasts the limit only at holds', async ({ app }) => { await app.open('/slow-1'); await app.open('/slow-2'); });\n` },
      { configSource: workerFakeConfigSource(1), runOptions: { beforeStep, maxDuration: 4_000 } },
    );
    project.cleanup();
    expect(outcome.report.run.errors).toEqual([]);
    expect(resultByTitle(outcome, 'outlasts the limit only at holds').status).toBe('passed');
  }, 60_000);

  it('kills a worker that blocks its event loop after a hold on the budget it had left, not counting the hold', async () => {
    // The watchdog pings once the timeout is spent and kills a worker that
    // has not answered after at least 5 s. Counting from the release, that
    // is no sooner than hold + timeout + 5 s; counting the hold, 3 s sooner.
    const hold = 3_000;
    const timeout = 6_000;
    const { beforeStep } = holder(hold);
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/block.e2e.ts': `import { test } from 'e2e';\ntest('blocks after a hold', async ({ app }) => { await app.open('/slow'); const end = Date.now() + 60_000; while (Date.now() < end) {} });\n` },
      { configSource: workerFakeConfigSource(1, `\n  timeout: ${timeout},\n  cleanupTimeout: 500,`), runOptions: { beforeStep } },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'blocks after a hold').attempts[0];
    expect(attempt?.status).toBe('timed-out');
    expect(attempt?.error?.message).toContain(`past its ${timeout} ms timeout`);
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(hold + timeout + 4_500);
  }, 90_000);
});

describe('beforeStep ending a hold', () => {
  it('fails a held step the body never awaited, and lets its hold go', async () => {
    const signals: AbortSignal[] = [];
    // The call sits in an async helper, whose own rejection must not reach the worker as a second error.
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/unawaited.e2e.ts': `import { test } from 'e2e';\ntest('forgets to await', async ({ app }) => { void (async () => { await app.open('/never'); })(); });\n` },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          beforeStep: (_step, { signal }) => {
            signals.push(signal);
            return new Promise<void>(() => undefined);
          },
        },
      },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'forgets to await').attempts[0];
    expect(attempt?.error?.code).toBe('STEP_NOT_AWAITED');
    expect(attempt?.steps).toMatchObject([{ api: 'app.open', label: '/never', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } }]);
    expect(attempt?.secondaryErrors).toEqual([]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  }, 60_000);

  it.each([
    ['rejects', () => Promise.reject(new Error('the prompt broke'))],
    ['throws', () => { throw new Error('the prompt broke'); }],
  ])('stops the run with the error a hook that %s gives, not as interrupted', async (_, beforeStep: () => Promise<void>) => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/broken.e2e.ts': `import { test } from 'e2e';\ntest('meets a broken hook', async ({ app }) => { await app.open('/'); });\n` },
      { configSource: workerFakeConfigSource(1), runOptions: { beforeStep } },
    );
    project.cleanup();
    expect(outcome.report.run.errors.map((error) => error.message)).toContain('the prompt broke');
    expect(outcome.exitCode).not.toBe(130);
    expect(outcome.exitCode).not.toBe(0);
  }, 60_000);

  it('ends a held step as interrupted when the run is interrupted', async () => {
    const interrupt = new AbortController();
    const signals: AbortSignal[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/stop.e2e.ts': `import { test } from 'e2e';\ntest('is stopped while held', async ({ app }) => { await app.open('/held'); });\ntest('never starts', async ({ app }) => { await app.open('/'); });\n`,
      },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          interruptSignal: interrupt.signal,
          beforeStep: (_step, { signal }) => {
            signals.push(signal);
            interrupt.abort();
            return new Promise<void>(() => undefined);
          },
        },
      },
    );
    project.cleanup();
    expect(outcome.exitCode).toBe(130);
    expect(resultByTitle(outcome, 'is stopped while held').status).toBe('interrupted');
    expect(resultByTitle(outcome, 'never starts').status).toBe('skipped');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }, 60_000);

  it('refuses the json reporter, whose stdout the prompt would break', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/any.e2e.ts': `import { test } from 'e2e';\ntest('never runs', async () => {});\n` },
      { configSource: workerFakeConfigSource(1, `\n  reporters: ['json'],`), runOptions: { beforeStep: () => Promise.resolve() } },
    );
    project.cleanup();
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors[0]).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('--step') });
  }, 60_000);
});
