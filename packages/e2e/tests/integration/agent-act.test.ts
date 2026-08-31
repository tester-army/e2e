/**
 * `agent.act()` coverage: the harness-owned step dispatch (RFC0001 layer 3),
 * the raw StepExecutor socket driven by a hand-rolled executor with no AI SDK,
 * and the default ToolLoopAgent executor driven by a scripted tool-calling
 * model. Real Playwright observations and actions throughout.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';

const SUITE = `import { test, expect } from 'e2e';

test('scripted executor increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once and verify it shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

const BLOCKED_SUITE = `import { test } from 'e2e';

test('executor reports a blocked step', async ({ app, agent }) => {
  await app.open();
  await agent.act('log in with the staging account');
});
`;

const BUDGET_SUITE = `import { test } from 'e2e';

test('executor overruns the action budget', async ({ app, agent }) => {
  await app.open();
  await agent.act('keep clicking forever', undefined, { maxSteps: 2 });
});
`;

const LOOP_SUITE = `import { test, expect } from 'e2e';

test('default agent increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once and verify it shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

/** Taps the Increment button, verifies the counter, and passes. No AI SDK. */
function scriptedExecutor(): StepExecutor {
  return {
    name: 'scripted-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      let observation = await context.observe();
      const id = nodeIdFor(observation.text, /button "Increment"/);
      await context.actions.tap({ id });
      observation = await context.observe();
      if (!/status.*"1"|"Counter".*value="1"/.test(observation.text)) {
        return { status: 'failed' as const, summary: 'the counter did not show 1 after one tap' };
      }
      return { status: 'passed' as const, summary: 'tapped Increment; the counter shows 1' };
    },
  };
}

describe('agent.act with a hand-rolled step executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/act.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
          agent: { executor: scriptedExecutor() },
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

  it('passes the test through the socket without any AI SDK involvement', () => {
    expect(resultByTitle(outcome, 'scripted executor increments the counter').status).toBe(
      'passed',
    );
    expect(outcome.exitCode).toBe(0);
  });

  it('records the act step with harness-owned accounting', () => {
    const attempt = resultByTitle(
      outcome,
      'scripted executor increments the counter',
    ).attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.act');
    expect(step).toBeDefined();
    expect(step!.kind).toBe('agent');
    expect(step!.status).toBe('passed');
    expect(step!.metrics!.actionSteps).toBe(1);
    expect(step!.explanation).toContain('the counter shows 1');
    const driverEvents = step!.events.filter((event) => event.kind === 'driver');
    const observations = step!.events.filter((event) => event.kind === 'observation');
    expect(driverEvents).toHaveLength(1);
    expect(observations).toHaveLength(2);
  });

  it('emits a schema-valid report for executor-driven steps', () => {
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as object;
    assertValidReport(report);
  });
});

describe('agent.act verdict mapping', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('maps a blocked verdict onto its error code and the configuration exit code', async () => {
    const executor: StepExecutor = {
      name: 'blocked-executor',
      async runStep() {
        return {
          status: 'blocked' as const,
          summary: 'the staging credential is not configured',
          errorCode: 'AUTH_CREDENTIAL_UNAVAILABLE' as const,
        };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/blocked.e2e.ts': BLOCKED_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      const result = resultByTitle(outcome, 'executor reports a blocked step');
      expect(result.status).toBe('failed');
      const error = result.attempts.at(-1)!.error;
      expect(error?.code).toBe('AUTH_CREDENTIAL_UNAVAILABLE');
      expect(error?.message).toContain('blocked');
      // Blocked-for-configuration is distinguishable from a product failure at
      // the process boundary: exit 2, not the test-failure exit 1.
      expect(outcome.exitCode).toBe(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('fails closed when the executor claims success over an exhausted budget', async () => {
    const executor: StepExecutor = {
      name: 'over-budget-executor',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        const id = nodeIdFor(observation.text, /button "Increment"/);
        // Swallow every failure and claim success; the harness must not let
        // the verdict outrank its own budget accounting.
        for (let round = 0; round < 5; round += 1) {
          try {
            await context.actions.tap({ id });
          } catch {
            break;
          }
        }
        return { status: 'passed' as const, summary: 'all good, nothing to see' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/budget.e2e.ts': BUDGET_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      const result = resultByTitle(outcome, 'executor overruns the action budget');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_BUDGET_EXHAUSTED');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('rejects a verdict outside the closed grammar', async () => {
    const executor: StepExecutor = {
      name: 'rogue-executor',
      async runStep() {
        return { status: 'passed' as const, summary: '' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/blocked.e2e.ts': BLOCKED_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      const result = resultByTitle(outcome, 'executor reports a blocked step');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('MODEL_OUTPUT_INVALID');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('agent.act with the default ToolLoopAgent executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => {
      if (call.lastToolResult === '') {
        // First turn: the prompt carries the instruction and initial screen.
        const id = nodeIdFor(call.prompt, /button "Increment"/);
        return [{ toolName: 'tap', input: { target: id } }];
      }
      // The tap result carries the updated screen; conclude once it shows 1.
      if (/Updated screen/.test(call.lastToolResult)) {
        return [
          {
            toolName: 'complete_step',
            input: {
              status: 'passed',
              summary: 'tapped Increment and the counter shows 1',
            },
          },
        ];
      }
      throw new Error(`unexpected loop state: ${call.lastToolResult}`);
    });
    const result = await runProject(
      { 'tests/loop.e2e.ts': LOOP_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: { model, context: 'This is the e2e fixture application.' },
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

  it('drives the step through the tool loop to a passed verdict', () => {
    expect(resultByTitle(outcome, 'default agent increments the counter').status).toBe('passed');
  });

  it('offers the default toolset and concludes through complete_step', () => {
    expect(loopCalls.length).toBeGreaterThanOrEqual(2);
    expect(loopCalls[0]!.toolNames).toEqual([
      'complete_step',
      'navigate',
      'observe',
      'press',
      'scroll',
      'select',
      'tap',
      'type',
    ]);
    expect(loopCalls[0]!.prompt).toContain('increment the counter once');
    expect(loopCalls[1]!.lastToolResult).toContain('Updated screen');
  });

  it('accounts executor model calls in the step metrics and provenance', () => {
    const attempt = resultByTitle(outcome, 'default agent increments the counter').attempts.at(
      -1,
    )!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.act');
    expect(step!.metrics!.modelCalls).toBeGreaterThanOrEqual(2);
    expect(step!.metrics!.actionSteps).toBe(1);
    expect(step!.model).toMatchObject({
      provider: 'fake-loop',
      model: 'scripted-loop',
      tokenAccounting: 'provider',
      calls: step!.metrics!.modelCalls,
    });
    expect(step!.model!.inputTokens).toBeGreaterThan(0);
    expect(step!.events.filter((event) => event.kind === 'model')).toHaveLength(
      step!.metrics!.modelCalls,
    );
  });
});
