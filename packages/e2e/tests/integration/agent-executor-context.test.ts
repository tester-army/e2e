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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: probing } } },
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: looking } } },
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
          config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', agents: { default: passing(mode) } },
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

const ASSERT_EVIDENCE_SUITE = `import { test } from 'e2e';

test('assert evidence under a custom executor', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the counter shows zero', { screenshot: false });
  await agent.assert('the counter shows zero');
  await agent.assert('the checkout page is visible');
});
`;

describe('assert evidence under a custom executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  const judging: StepExecutor = {
    name: 'judging',
    version: '1',
    async runStep(context: StepExecutorContext) {
      return context.step.instruction.includes('checkout')
        ? { status: 'failed', summary: 'no checkout page exists here' }
        : { status: 'passed', summary: 'the counter reads 0' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/evidence.e2e.ts': ASSERT_EVIDENCE_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: judging } } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('takes the screenshot after the verdict, on a pass and on a failure alike, and none with screenshot: false', () => {
    expect(outcome.exitCode).toBe(1);
    const attempt = resultByTitle(outcome, 'assert evidence under a custom executor').attempts.at(-1)!;
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    const asserts = attempt.steps.filter((step) => step.api === 'agent.assert');
    expect(asserts.map((step) => step.status)).toEqual(['passed', 'passed', 'failed']);
    const screenshotsOf = (step: (typeof asserts)[number]) =>
      attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && step.artifacts.includes(artifact.id));
    expect(screenshotsOf(asserts[0]!)).toHaveLength(0);
    expect(screenshotsOf(asserts[1]!)).toHaveLength(1);
    expect(screenshotsOf(asserts[2]!)).toHaveLength(1);
  });
});
