/**
 * The `onEvent` host stream end to end: a real run emits an ordered,
 * JSON-serializable event sequence that mirrors what the report persists,
 * while a throwing sink is quarantined without affecting the run.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { credentials } from '../../src/index.ts';
import {
  createProject,
  runExisting,
  runProjectWithConfigFile,
  workerConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { RunEvent } from '../../src/run/events.ts';

const SUITE = `import { test, expect } from 'e2e';

test('increments once', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

/** Taps Increment once and passes. No AI SDK, no model. */
const oneTapExecutor: StepExecutor = {
  name: 'one-tap-executor',
  async runStep(context) {
    const observation = await context.observe();
    await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
    return { status: 'passed', summary: 'tapped increment once' };
  },
};

describe('run events', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const events: RunEvent[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/events.e2e.ts': SUITE });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: oneTapExecutor } },
        cache: 'off' as const,
      },
      runOptions: { onEvent: (event) => {
        events.push(event);
      } },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes and emits the full lifecycle in order', () => {
    expect(outcome.exitCode).toBe(0);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run-started');
    // Between the header and the plan there are only setup steps (collection,
    // each target's prepare) and the notices they narrate.
    const planIndex = types.indexOf('plan');
    expect(planIndex).toBeGreaterThan(0);
    expect(types.slice(1, planIndex).filter((type) => type !== 'setup' && type !== 'notice')).toEqual([]);
    expect(types.slice(1, planIndex)).toContain('setup');
    expect(types.at(-1)).toBe('run-finished');
    expect(types.indexOf('test-started')).toBeLessThan(types.indexOf('step'));
    expect(types.indexOf('step')).toBeLessThan(types.indexOf('test-finished'));
  });

  it('starts the run clock with the plan', () => {
    // Collection and engine provisioning happen between run-started and
    // plan; the report's span begins with the plan, not the launch.
    const at = (type: RunEvent['type']) => Date.parse(events.find((event) => event.type === type)!.at);
    const startedAt = Date.parse(outcome.report.run.startedAt);
    expect(startedAt).toBeGreaterThanOrEqual(at('run-started'));
    expect(startedAt).toBeLessThanOrEqual(at('plan'));
  });

  it('stamps a strictly increasing seq', () => {
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('emits only JSON-serializable payloads', () => {
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  it('carries redacted prose detail on engine action events', () => {
    const engineEvents = events.flatMap((event) =>
      event.type === 'step' && event.progress.phase === 'event' && event.progress.event.kind === 'engine'
        ? [event.progress.event]
        : [],
    );
    expect(engineEvents.length).toBeGreaterThan(0);
    expect(engineEvents[0]?.detail).toBe('tap button "Increment"');
  });

  it('streams step phases for the agent step', () => {
    const stepEvents = events.filter(
      (event) => event.type === 'step' && event.progress.api === 'agent.act',
    );
    const phases = stepEvents.map((event) => (event.type === 'step' ? event.progress.phase : ''));
    expect(phases[0]).toBe('start');
    expect(phases.at(-1)).toBe('end');
  });

  it('flattens the test-finished target to its stable identity', () => {
    const finished = events.find((event) => event.type === 'test-finished');
    expect(finished).toBeDefined();
    if (finished?.type !== 'test-finished') return;
    expect(finished.result.target).toEqual({ name: 'web', platform: 'web' });
    expect(finished.result.status).toBe('passed');
  });

  it('mirrors run-finished onto the outcome', () => {
    const finished = events.at(-1);
    if (finished?.type !== 'run-finished') throw new Error('missing run-finished');
    expect(finished.status).toBe(outcome.status);
    expect(finished.exitCode).toBe(outcome.exitCode);
    expect(finished.reportPath).toBe(outcome.reportPath);
  });
});

describe('run events: attempt and step identity', () => {
  it.each(['in-process', 'workers'] as const)('joins retries and serial members to their report records through %s', async (execution) => {
    const app = await startFixtureApp();
    const events: RunEvent[] = [];
    const files = {
      'tests/retry.e2e.ts': `import { test } from 'e2e';
test('retry', { retries: 1 }, async ({ app, agent }) => {
  await app.open();
  await agent.act('retry me');
});`,
      'tests/serial.e2e.ts': `import { test } from 'e2e';
test.describe('group', { serial: true, retries: 1 }, () => {
  test('first', async ({ app, agent }) => {
    await app.open();
    await agent.act('pass');
  });
  test('second', async ({ agent }) => { await agent.act('retry me'); });
});`,
    };
    const executor: StepExecutor = {
      name: 'retry-once',
      async runStep(context) {
        return context.step.instruction === 'retry me' && context.attempt.index === 0
          ? { status: 'failed', summary: 'first attempt fails' }
          : { status: 'passed', summary: 'recovered' };
      },
    };
    let project: FixtureProject | undefined;
    try {
      let outcome: RunOutcome;
      const runOptions = { onEvent: (event: RunEvent) => { events.push(event); } };
      if (execution === 'workers') {
        const result = await runProjectWithConfigFile(files, {
          appUrl: app.url,
          configSource: workerConfigSource(2, `
  cache: 'off',
  agents: { default: { executor: {
    name: 'retry-once',
    async runStep(context) {
      return context.step.instruction === 'retry me' && context.attempt.index === 0
        ? { status: 'failed', summary: 'first attempt fails' }
        : { status: 'passed', summary: 'recovered' };
    },
  } } },`),
          runOptions,
        });
        project = result.project;
        outcome = result.outcome;
      } else {
        project = createProject(files);
        outcome = await runExisting(project, {
          appUrl: app.url,
          config: { cache: 'off', agents: { default: { executor } } },
          runOptions,
        });
      }
      expect(outcome.status).toBe('passed');
      const ordinary = outcome.report.run.results.find((result) => result.serialGroupId === undefined)!;
      const group = outcome.report.run.serialGroups[0]!;
      expect(ordinary.status).toBe('flaky');
      expect(group.status).toBe('flaky');
      expect(ordinary.attempts.map((attempt) => attempt.index)).toEqual([0, 1]);
      expect(group.attempts.map((attempt) => attempt.index)).toEqual([0, 1]);
      const records = [
        ...ordinary.attempts.flatMap((attempt) => attempt.steps.map((step) => ({ attempt, step, testId: ordinary.testId }))),
        ...group.attempts.flatMap((attempt) => attempt.members.flatMap((member) =>
          member.steps.map((step) => ({ attempt, step, testId: member.testId })))),
      ];
      const stepEvents = events.filter((event) => event.type === 'step');
      expect(stepEvents.filter((event) => event.progress.phase === 'start')).toHaveLength(records.length);
      expect(stepEvents.filter((event) => event.progress.phase === 'end')).toHaveLength(records.length);
      for (const event of stepEvents) {
        const record = records.find(({ step }) => step.id === event.progress.identity?.stepId);
        expect(record, JSON.stringify(event)).toBeDefined();
        const { attempt, step, testId } = record!;
        expect(event.testId).toBe(testId);
        expect(event.progress.identity).toEqual({
          attemptId: attempt.id, attemptIndex: attempt.index, stepId: step.id, stepIndex: step.index,
        });
        if (event.progress.phase === 'end') {
          expect(event.progress.status).toBe(step.status);
          expect(event.progress.error?.message).toBe(step.error?.message);
          expect(event.progress.explanation).toBe(step.explanation);
        }
      }
    } finally {
      project?.cleanup();
      await app.close();
    }
  }, 120_000);
});

describe('run events: run lifecycle hygiene', () => {
  it('a test\u2019s console output arrives as output events attributed to it, and never on the runner\u2019s streams', async () => {
    const app = await startFixtureApp();
    const events: RunEvent[] = [];
    const written: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let project: FixtureProject | undefined;
    try {
      const result = await runProjectWithConfigFile(
        {
          'tests/logs.e2e.ts': `import { test } from 'e2e';
console.log('top level');
test('talks', async () => {
  console.log('hello', { from: 'the test' });
  console.error('careful');
  process.stdout.write('token sk_live_generic_4242 leaked');
  process.stdout.write(' twice sk_live_generic_4242\\n');
  process.stdout.write('split sk_live_gen');
  process.stdout.write('eric_4242 across writes\\n');
});
`,
        },
        {
          appUrl: app.url,
          configSource: workerConfigSource(1, `
  secrets: { 'stripe-key': 'sk_live_generic_4242' },`),
          runOptions: { onEvent: (event: RunEvent) => { events.push(event); } },
        },
      );
      project = result.project;
      expect(result.outcome.status).toBe('passed');
      const output = events.filter((event) => event.type === 'output');
      const started = events.find((event) => event.type === 'test-started')!;
      const inTest = output.filter((event) => event.pair?.testId === started.testId);
      // Secret values are redacted before output leaves the worker, across writes: a write that
      // ends mid-line holds back what a later write could complete into a value, so the pieces of
      // one line may land as one event or several, never with a piece of a secret in any of them.
      const joined = (stream: string): string =>
        inTest.filter((event) => event.stream === stream).map((event) => event.text).join('');
      expect(inTest[0]).toMatchObject({ stream: 'stdout', text: "hello { from: 'the test' }\n" });
      expect(joined('stderr')).toBe('careful\n');
      expect(joined('stdout')).toBe(
        "hello { from: 'the test' }\ntoken <secret:stripe-key> leaked twice <secret:stripe-key>\nsplit <secret:stripe-key> across writes\n",
      );
      expect(events.some((event) => event.type === 'output' && /sk_live|eric_4242/.test(event.text))).toBe(false);
      expect(inTest.every((event) => event.target === 'web' && event.pair?.agent === 'default')).toBe(true);
      // The module's top level runs while the file loads, outside any pair.
      expect(output.some((event) => event.pair === undefined && event.text === 'top level\n')).toBe(true);
      expect(written.join('')).not.toContain('hello');
    } finally {
      stdoutWrite.mockRestore();
      project?.cleanup();
      await app.close();
    }
  }, 120_000);

  it('a serial member’s unfinished line leaves with the member that wrote it, not the one after', async () => {
    const app = await startFixtureApp();
    const events: RunEvent[] = [];
    let project: FixtureProject | undefined;
    try {
      const result = await runProjectWithConfigFile(
        {
          'tests/serial-logs.e2e.ts': `import { test } from 'e2e';
test.describe('shared', { serial: true }, () => {
  test('first', async () => { process.stdout.write('progress'); });
  test('second', async () => { process.stdout.write(' done\\n'); });
});
`,
        },
        {
          appUrl: app.url,
          // A registered secret is what makes the worker hold an unfinished line.
          configSource: workerConfigSource(1, `
  secrets: { 'stripe-key': 'sk_live_generic_4242' },`),
          runOptions: { onEvent: (event: RunEvent) => { events.push(event); } },
        },
      );
      project = result.project;
      expect(result.outcome.status).toBe('passed');
      const started = new Map(
        events.flatMap((event) => (event.type === 'test-started' ? [[event.title, event.testId] as const] : [])),
      );
      const outputOf = (title: string): string[] => {
        const testId = started.get(title);
        expect(testId).toBeDefined();
        return events.flatMap((event) => (event.type === 'output' && event.pair?.testId === testId ? [event.text] : []));
      };
      expect(outputOf('shared > first')).toEqual(['progress']);
      expect(outputOf('shared > second')).toEqual([' done\n']);
    } finally {
      project?.cleanup();
      await app.close();
    }
  }, 120_000);

  it('a junit-write failure is one stderr line and leaves the outcome, the report, and run-finished alone', async () => {
    const app = await startFixtureApp();
    const project = createProject({ 'tests/events.e2e.ts': SUITE });
    // A directory where junit.xml must be written makes its atomic rename fail
    // while report.json beside it still has a clear path.
    mkdirSync(path.join(project.dir, '.e2e', 'junit.xml'), { recursive: true });
    const events: RunEvent[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['junit'] as const,
          agents: { default: { executor: oneTapExecutor } },
          cache: 'off' as const,
        },
        runOptions: { onEvent: (event) => {
          events.push(event);
        } },
      });
      // The junit reporter is a reporter: like any other it cannot change the outcome.
      expect(outcome.exitCode).toBe(0);
      expect(outcome.status).toBe('passed');
      expect(outcome.reportPath).toBe(path.join(project.dir, '.e2e', 'report.json'));
      const persisted = JSON.parse(readFileSync(outcome.reportPath!, 'utf8')) as typeof outcome.report;
      expect(persisted.run.errors).toEqual([]);
      expect(events.map((event) => event.type)).not.toContain('run-error');
      const finished = events.at(-1);
      if (finished?.type !== 'run-finished') throw new Error('missing run-finished');
      expect(finished.status).toBe('passed');
      expect(finished.reportPath).toBe(outcome.reportPath);
      const written = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain('e2e: reporter "junit" failed:');
    } finally {
      vi.restoreAllMocks();
      project.cleanup();
      await app.close();
    }
  }, 120_000);

  it('a report-write failure fails the run, withholds reportPath, and precedes run-finished', async () => {
    const app = await startFixtureApp();
    const project = createProject({ 'tests/events.e2e.ts': SUITE });
    // A directory where report.json must be written makes the atomic rename fail.
    mkdirSync(path.join(project.dir, '.e2e', 'report.json'), { recursive: true });
    const events: RunEvent[] = [];
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agents: { default: { executor: oneTapExecutor } },
          cache: 'off' as const,
        },
        runOptions: { onEvent: (event) => {
        events.push(event);
      } },
      });
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.status).toBe('error');
      expect(outcome.reportPath).toBeUndefined();
      const types = events.map((event) => event.type);
      const reportError = types.indexOf('run-error');
      expect(reportError).toBeGreaterThan(-1);
      expect(reportError).toBeLessThan(types.indexOf('run-finished'));
      const finished = events.at(-1);
      if (finished?.type !== 'run-finished') throw new Error('missing run-finished');
      expect(finished.exitCode).toBe(outcome.exitCode);
      expect(finished.reportPath).toBeUndefined();
      // The in-memory report is the only complete record and carries the error.
      expect(outcome.report.run.errors.some((entry) => entry.phase === 'report')).toBe(true);
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);

  it('a cancellation before any test starts ends the run as interrupted without collecting', async () => {
    const app = await startFixtureApp();
    const project = createProject({ 'tests/events.e2e.ts': SUITE });
    const events: RunEvent[] = [];
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agents: { default: { executor: oneTapExecutor } },
          cache: 'off' as const,
        },
        runOptions: {
          interruptSignal: AbortSignal.abort(),
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      expect(outcome.exitCode).toBe(130);
      expect(outcome.status).toBe('interrupted');
      expect(outcome.results).toHaveLength(0);
      const types = events.map((event) => event.type);
      expect(types).toEqual(['run-started', 'run-interrupted', 'run-finished']);
      // Nothing ran, so nothing is written: the last run's report stays the one --last-failed reads.
      expect(outcome.reportPath).toBeUndefined();
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);

  it('clears the credential registry when the run resolves', async () => {
    const app = await startFixtureApp();
    const project = createProject({ 'tests/events.e2e.ts': SUITE });
    try {
      await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agents: { default: { executor: oneTapExecutor } },
          cache: 'off' as const,
          credentials: { member: { username: 'member', password: 'hunter2' } },
        },
      });
      expect(() => credentials.user('member')).toThrow(/only available while the e2e runner/);
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);
});

describe('run events: quarantined sink', () => {
  it('a throwing sink never affects the run outcome', async () => {
    const app = await startFixtureApp();
    const project = createProject({ 'tests/events.e2e.ts': SUITE });
    let calls = 0;
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agents: { default: { executor: oneTapExecutor } },
          cache: 'off' as const,
        },
        runOptions: {
          onEvent: () => {
            calls += 1;
            throw new Error('broken sink');
          },
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(calls).toBe(1);
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);
});
