/**
 * The executor owns its context: attempt identity and lifecycle, structured prior steps, the
 * per-attempt memory, opt-in tree and pixels on `observe()`, per-executor
 * cache opt-out, and the built-in agent carrying its conversation across the
 * steps of a test. Real Playwright observations throughout.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const TWO_TESTS_SUITE = `import { test } from 'e2e';

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

const ONE_STEP_SUITE = `import { test } from 'e2e';

test('one act step', async ({ app, agent }) => {
  await app.open();
  await agent.act('look at the screen');
});
`;

interface Probe {
  readonly instruction: string;
  readonly testId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly stepIndex: number;
  readonly memoryBefore: unknown;
  readonly signal: AbortSignal;
}

describe('the executor context: attempt and memory', () => {
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: probing } } } },
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: looking } } } },
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

  it('returns masked pixels when the engine can prove masking', () => {
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
          config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', agents: { default: { executor: passing(mode) } } },
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

const ASSERT_EVIDENCE_SUITE = `import { test, credentials } from 'e2e';

test('assert evidence under a custom executor', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the counter shows zero', { screenshot: false });
  await agent.assert('the counter shows zero');
  await agent.assert('the checkout page is visible');
});

test('a failed verdict carries its screenshot', async ({ app, agent }) => {
  await app.open();
  try {
    await agent.assert('the checkout page is visible');
  } catch (error) {
    // The path the test body was handed, surfaced where the report can show it.
    error.message += ' [screenshot=' + String(error.screenshot) + ']';
    throw error;
  }
});

test('vision belongs to the executor', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the counter shows zero, judged from pixels', { vision: true });
});

test('assert evidence after a secret fill', async ({ app, agent }) => {
  await app.open();
  await agent.act('sign in with the given credentials', { params: { password: credentials.user('admin').password } });
  await agent.assert('the counter shows zero');
  await agent.assert('the checkout page is visible');
});
`;

describe('assert evidence under a custom executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  /** Every instruction the executor was handed, in order. */
  const seen: string[] = [];
  const judging: StepExecutor = {
    name: 'judging',
    version: '1',
    async runStep(context: StepExecutorContext) {
      seen.push(context.step.instruction);
      if (context.step.instruction.includes('sign in')) {
        const observation = await context.observe();
        await context.actions.typeSecret({ id: nodeIdFor(observation.text, /textbox "Password"/) }, 'admin.password');
        return { status: 'passed', summary: 'filled the password' };
      }
      return context.step.instruction.includes('checkout')
        ? { status: 'failed', summary: 'no checkout page exists here' }
        : { status: 'passed', summary: 'the counter reads 0' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/evidence.e2e.ts': ASSERT_EVIDENCE_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { executor: judging } },
          credentials: { admin: { username: 'admin', password: 'admin-pass' } },
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

  type Attempt = ReturnType<typeof resultByTitle>['attempts'][number];
  /** The screenshot artifacts attached to one step. */
  const screenshotsOf = (attempt: Attempt, step: Attempt['steps'][number]) =>
    attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && step.artifacts.includes(artifact.id));
  const lastAttempt = (title: string) => resultByTitle(outcome, title).attempts.at(-1)!;

  it('takes the screenshot after the verdict, on a pass and on a failure alike, and none with screenshot: false', () => {
    const result = resultByTitle(outcome, 'assert evidence under a custom executor');
    expect(result.status).toBe('failed');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    const asserts = attempt.steps.filter((step) => step.api === 'agent.assert');
    expect(asserts.map((step) => step.status)).toEqual(['passed', 'passed', 'failed']);
    expect(screenshotsOf(attempt, asserts[0]!)).toHaveLength(0);
    expect(screenshotsOf(attempt, asserts[1]!)).toHaveLength(1);
    expect(screenshotsOf(attempt, asserts[2]!)).toHaveLength(1);
  });

  it('hands the failed verdict the path of its screenshot, and the runner keeps its own failure capture beside it', () => {
    const attempt = lastAttempt('a failed verdict carries its screenshot');
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.assert')!;
    const [evidence, ...more] = screenshotsOf(attempt, step);
    expect(more).toEqual([]);
    // The test body is handed the path inside the attempt's artifact directory; the record's path prefixes that directory.
    const handed = / \[screenshot=([^\]]+)\]$/.exec(attempt.error?.message ?? '')?.[1];
    expect(handed).toMatch(/^screenshots\/\d+-assert\.png$/);
    expect(evidence!.path!.endsWith(`/${handed}`)).toBe(true);
    // What the runner saw when the failure landed is a capture of its own, not the step's evidence.
    expect(attempt.failure?.screen).toBeDefined();
    expect(attempt.failure?.screenshot).toBeDefined();
    expect(attempt.failure?.screenshot).not.toBe(evidence!.id);
    expect(attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screenshot)?.kind).toBe('screenshot');
  });

  it('refuses vision with UNSUPPORTED_CAPABILITY before the executor is asked: what its model sees is its own call', () => {
    const attempt = lastAttempt('vision belongs to the executor');
    expect(attempt.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(attempt.error?.message).toContain('vision');
    expect(seen).not.toContain('the counter shows zero, judged from pixels');
    // Rejected at the call, before a step opens: the attempt records no assert step.
    expect(attempt.steps.filter((step) => step.api === 'agent.assert')).toEqual([]);
    // A configuration error in one test decides the run's exit code, over the assertion failures beside it.
    expect(attempt.error?.category).toBe('configuration');
    expect(outcome.exitCode).toBe(2);
  });

  it('denies the screenshot as PIXEL_TAINTED after a secret fill, on both verdicts, and the failure capture keeps no pixels either', () => {
    const attempt = lastAttempt('assert evidence after a secret fill');
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    expect(attempt.steps.find((step) => step.api === 'agent.act')?.status).toBe('passed');
    const asserts = attempt.steps.filter((step) => step.api === 'agent.assert');
    expect(asserts.map((step) => step.status)).toEqual(['passed', 'failed']);
    for (const step of asserts) {
      expect(screenshotsOf(attempt, step)).toEqual([]);
      expect(step.events.filter((event) => event.kind === 'policy')).toEqual([
        expect.objectContaining({ name: 'assert.screenshot', decision: 'denied', code: 'PIXEL_TAINTED', status: 'failed' }),
      ]);
    }
    // The one frame is the step before the fill (the default every-step frame of app.open); nothing after it.
    const openStep = attempt.steps.find((step) => step.api === 'app.open')!;
    expect(attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot').map((artifact) => artifact.producer)).toEqual([
      { kind: 'step', stepId: openStep.id },
    ]);
    expect(attempt.failure?.screen).toBeDefined();
    expect(attempt.failure?.screenshot).toBeUndefined();
  });
});
