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

const SUITE = `import { test, expect } from '@e2edev/e2e';

test('scripted executor increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once and verify it shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

const BLOCKED_SUITE = `import { test } from '@e2edev/e2e';

test('executor reports a blocked step', async ({ app, agent }) => {
  await app.open();
  await agent.act('log in with the staging account');
});
`;

const BUDGET_SUITE = `import { test } from '@e2edev/e2e';

test('executor overruns the action budget', async ({ app, agent }) => {
  await app.open();
  await agent.act('keep clicking forever', undefined, { maxSteps: 2 });
});
`;

const HANG_SUITE = `import { test } from '@e2edev/e2e';

test('executor hangs past the step timeout', async ({ app, agent }) => {
  await app.open();
  await agent.act('do something eventually', undefined, { timeout: 500 });
});
`;

const HANGING_PAGE_SUITE = `import { test } from '@e2edev/e2e';

test('a page that never settles costs one action timeout', async ({ app, agent }) => {
  await app.open();
  await agent.act('open the hanging page', undefined, { timeout: 60_000 });
});
`;

const OVERSPEND_SUITE = `import { test } from '@e2edev/e2e';

test('executor overspends the model-call budget', async ({ app, agent }) => {
  await app.open();
  await agent.act('think very hard', undefined, { maxModelCalls: 2 });
});
`;

const INHERIT_SUITE = `import { test } from '@e2edev/e2e';

test('failed verdict inherits the runtime code', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap twice', undefined, { maxSteps: 1 });
});
`;

const LOOP_SUITE = `import { test, expect } from '@e2edev/e2e';

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
          agent: scriptedExecutor(),
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
    const backendEvents = step!.events.filter((event) => event.kind === 'backend');
    const observations = step!.events.filter((event) => event.kind === 'observation');
    expect(backendEvents).toHaveLength(1);
    // The executor's two looks, plus the trace cache's two (on by default):
    // the settled baseline before any action and the passing observation,
    // whose delta becomes the staged trace's end anchors.
    expect(observations).toHaveLength(4);
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
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
      // ...and blocked is first-class in the report: the step says blocked,
      // and a run whose every non-passing result is blockable says blocked.
      const step = result.attempts.at(-1)!.steps.find((s) => s.api === 'agent.act');
      expect(step?.status).toBe('blocked');
      expect(outcome.report.run.status).toBe('blocked');
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
    );
    try {
      const result = resultByTitle(outcome, 'executor overruns the action budget');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_BUDGET_EXHAUSTED');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('cuts a hanging executor at the step timeout', async () => {
    const executor: StepExecutor = {
      name: 'hanging-executor',
      runStep: () => new Promise(() => undefined),
    };
    const { outcome, project } = await runProject(
      { 'tests/hang.e2e.ts': HANG_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
    );
    try {
      const result = resultByTitle(outcome, 'executor hangs past the step timeout');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_TIMEOUT');
      // The step settled at its own 500 ms deadline, not the test timeout.
      expect(result.attempts.at(-1)!.durationMs).toBeLessThan(30_000);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('hard-stops an executor that overspends the model-call budget', async () => {
    const executor: StepExecutor = {
      name: 'overspending-executor',
      async runStep(context: StepExecutorContext) {
        for (let call = 0; call < 10; call += 1) {
          context.budgets.recordModelCall({ inputTokens: 1, outputTokens: 1 });
        }
        return { status: 'passed' as const, summary: 'thought about it a lot' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/overspend.e2e.ts': OVERSPEND_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
    );
    try {
      const result = resultByTitle(outcome, 'executor overspends the model-call budget');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_BUDGET_EXHAUSTED');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('stamps the runtime code onto a code-less failed verdict after a hard stop', async () => {
    const executor: StepExecutor = {
      name: 'code-less-executor',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        const id = nodeIdFor(observation.text, /button "Increment"/);
        try {
          await context.actions.tap({ id });
          await context.actions.tap({ id });
        } catch {
          // Swallow the budget error and report a bare product failure.
        }
        return { status: 'failed' as const, summary: 'the counter looked wrong' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/inherit.e2e.ts': INHERIT_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
    );
    try {
      const result = resultByTitle(outcome, 'failed verdict inherits the runtime code');
      expect(result.status).toBe('failed');
      const error = result.attempts.at(-1)!.error;
      expect(error?.code).toBe('STEP_BUDGET_EXHAUSTED');
      expect(error?.message).toContain('the counter looked wrong');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('routes agent.assert through a custom executor with assert semantics', async () => {
    const seen: string[] = [];
    const executor: StepExecutor = {
      name: 'judging-executor',
      async runStep(context: StepExecutorContext) {
        seen.push(`${context.step.kind}:${context.step.instruction}`);
        if (context.step.instruction.includes('checkout')) {
          return { status: 'failed' as const, summary: 'no checkout page exists here' };
        }
        const observation = await context.observe();
        return /status "Counter" text="0"|status.*"0"/.test(observation.text)
          ? { status: 'passed' as const, summary: 'the counter reads 0' }
          : { status: 'failed' as const, summary: 'the counter is not zero' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/assert.e2e.ts': ASSERT_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
    );
    try {
      const result = resultByTitle(outcome, 'custom executor judges assertions');
      expect(result.status).toBe('failed');
      // The failed assertion maps to ASSERTION_FAILED, not ACTION_FAILED.
      expect(result.attempts.at(-1)!.error?.code).toBe('ASSERTION_FAILED');
      expect(seen[0]).toBe('assert:the counter shows zero');
      const steps = result.attempts.at(-1)!.steps.filter((s) => s.api === 'agent.assert');
      expect(steps[0]!.status).toBe('passed');
      expect(steps[1]!.status).toBe('failed');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('fills a declared secret through typeSecret, never exposing the value', async () => {
    const executor: StepExecutor = {
      name: 'login-executor',
      async runStep(context: StepExecutorContext) {
        // The executor sees only the placeholder, never the plaintext.
        const params = JSON.stringify(context.step.params);
        if (params.includes('admin-pass')) {
          return { status: 'failed' as const, summary: 'plaintext leaked into params' };
        }
        if (context.step.secrets[0]?.name !== 'admin') {
          return { status: 'failed' as const, summary: 'secret was not declared' };
        }
        const observation = await context.observe();
        const password = nodeIdFor(observation.text, /textbox "Password"/);
        await context.actions.typeSecret({ id: password }, 'admin');
        // Undeclared names are refused before any policy check runs.
        try {
          await context.actions.typeSecret({ id: password }, 'other');
          return { status: 'failed' as const, summary: 'undeclared secret was accepted' };
        } catch {
          return { status: 'passed' as const, summary: 'filled the declared secret only' };
        }
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/secret.e2e.ts': SECRET_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: executor,
          credentials: { admin: { username: 'admin', password: 'admin-pass' } },
        },
      },
    );
    try {
      const result = resultByTitle(outcome, 'executor fills a declared secret');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('resolves a provider-backed secret at fill time and keeps the plaintext out of the report', async () => {
    const provider: { calls: number } = { calls: 0 };
    // Read through a call so control-flow narrowing cannot pin the counter:
    // the provider mutates it from inside the runner, invisibly to tsc.
    const callsSoFar = () => provider.calls;
    const executor: StepExecutor = {
      name: 'provider-login-executor',
      async runStep(context: StepExecutorContext) {
        if (callsSoFar() !== 0) {
          return { status: 'failed' as const, summary: 'provider resolved before the fill' };
        }
        const observation = await context.observe();
        const password = nodeIdFor(observation.text, /textbox "Password"/);
        await context.actions.typeSecret({ id: password }, 'admin');
        return callsSoFar() === 1
          ? { status: 'passed' as const, summary: 'provider resolved exactly once, at fill time' }
          : { status: 'failed' as const, summary: `provider resolved ${callsSoFar()} times` };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/secret.e2e.ts': SECRET_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: executor,
          credentials: {
            admin: {
              username: 'admin',
              password: () => {
                provider.calls += 1;
                return Promise.resolve('provider-pass-1');
              },
            },
          },
        },
      },
    );
    try {
      const result = resultByTitle(outcome, 'executor fills a declared secret');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      expect(JSON.stringify(outcome.report)).not.toContain('provider-pass-1');
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
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: executor } },
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

describe('agent.act backend operations are bounded by actionTimeout', () => {
  it('a page that never settles costs one action timeout, not the step budget', async () => {
    const app = await startFixtureApp();
    const executor: StepExecutor = {
      name: 'hang-navigator',
      version: 'test',
      async runStep(context: StepExecutorContext) {
        try {
          await context.actions.navigate('/hang');
        } catch (cause) {
          return {
            status: 'failed' as const,
            summary: `navigation gave up: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        return { status: 'failed' as const, summary: 'the hanging page unexpectedly loaded' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/hang.e2e.ts': HANGING_PAGE_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: executor,
          actionTimeout: 1_000,
        },
      },
    );
    try {
      const result = resultByTitle(outcome, 'a page that never settles costs one action timeout');
      expect(result.status).toBe('failed');
      const attempt = result.attempts.at(-1)!;
      const step = attempt.steps.find((candidate) => candidate.api === 'agent.act')!;
      // The 60s act budget is untouched: the hung navigation fails within its
      // own operation bound and the executor concludes, well under the clock.
      expect(step.error?.code).not.toBe('STEP_TIMEOUT');
      expect(step.durationMs).toBeLessThan(15_000);
      expect(step.explanation).toContain('navigation gave up');
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);
});

const ASSERT_SUITE = `import { test } from '@e2edev/e2e';

test('custom executor judges assertions', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the counter shows zero');
  await agent.assert('the checkout page is visible');
});
`;

const SECRET_SUITE = `import { test, credentials, expect } from '@e2edev/e2e';

test('executor fills a declared secret', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('sign in with the given credentials', {
    username: 'admin',
    password: credentials.user('admin').password,
  });
  // Secure fields refuse value reads by design; visibility is the most a
  // deterministic assertion may observe. The executor verified the fill.
  await expect(screen.getByLabel('Password')).toBeVisible();
});
`;

const LOOP_GUARD_SUITE = `import { test } from '@e2edev/e2e';

test('agent goes in circles', async ({ app, agent }) => {
  await app.open();
  await agent.act('keep poking the same thing forever');
});
`;

describe('loop guards and transcripts', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('forces a verdict when the model repeats itself, and persists the transcript', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1 && call.toolNames[0] === 'complete_step') {
        return [
          {
            toolName: 'complete_step',
            input: { status: 'failed', summary: 'stuck repeating the same tap' },
          },
        ];
      }
      const id = nodeIdFor(call.prompt, /button "Increment"/);
      return [{ toolName: 'tap', input: { target: id } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/loop-guard.e2e.ts': LOOP_GUARD_SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agent: { model } },
        runOptions: { debug: true },
      },
    );
    try {
      const result = resultByTitle(outcome, 'agent goes in circles');
      expect(result.status).toBe('failed');
      const attempt = result.attempts.at(-1)!;
      expect(attempt.error?.message).toContain('stuck repeating the same tap');
      const step = attempt.steps.find((candidate) => candidate.api === 'agent.act')!;
      // Five identical calls trip the stop; the forced turn concludes. Without
      // the guard this model would burn the whole 25-turn budget.
      expect(step.metrics!.modelCalls).toBeLessThanOrEqual(8);
      // --debug persists the executor transcript as a step-attributed log artifact.
      const log = attempt.artifacts.find((artifact) => artifact.kind === 'log');
      expect(log).toBeDefined();
      expect(log!.producer).toEqual({ kind: 'step', stepId: step.id });
      expect(log!.path).toBeDefined();
      const text = readFileSync(
        path.join(project.dir, '.e2e', 'artifacts', ...log!.path!.split('/')),
        'utf8',
      );
      expect(text).toContain('tool call: tap');
      expect(text).toContain('--- turn 1 ---');
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
