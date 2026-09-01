/**
 * The `onEvent` host stream end to end: a real run emits an ordered,
 * JSON-serializable event sequence that mirrors what the report persists,
 * while a throwing sink is quarantined without affecting the run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import {
  createProject,
  runExisting,
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
        agent: oneTapExecutor,
        cache: 'off' as const,
      },
      runOptions: { onEvent: (event) => events.push(event) },
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
    expect(types[1]).toBe('plan');
    expect(types.at(-1)).toBe('run-finished');
    expect(types.indexOf('test-started')).toBeLessThan(types.indexOf('step'));
    expect(types.indexOf('step')).toBeLessThan(types.indexOf('test-finished'));
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

  it('carries redacted prose detail on backend action events', () => {
    const backendEvents = events.flatMap((event) =>
      event.type === 'step' && event.progress.phase === 'event' && event.progress.event.kind === 'backend'
        ? [event.progress.event]
        : [],
    );
    expect(backendEvents.length).toBeGreaterThan(0);
    expect(backendEvents[0]?.detail).toBe('tap button "Increment"');
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
          agent: oneTapExecutor,
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
