/**
 * How fast a trace replay is against the deterministic API it stands in for.
 * One flow, three ways, on the fixture app: `locator.fill` and `locator.click`
 * as a test would write them, the same flow as an `agent.act` recorded
 * through a scripted model, and that recording replayed with no model call.
 * The wall times come from the report's step timings and are printed so a CI
 * log shows them; the bound is generous on purpose, since the integration
 * project runs three files at once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelInstance } from '../../src/index.ts';
import type { StepRecord } from '../../src/run/steps.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopToolCall } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const REPETITIONS = [1, 2, 3] as const;

/**
 * A replay may take this many times the deterministic twin, and never less
 * than the floor: the twin is a few hundred milliseconds, and a settled
 * observation or two of scheduling noise on a loaded CI runner must not fail
 * the build.
 */
const REPLAY_RATIO = 3;
const REPLAY_FLOOR_MS = 1_500;

const SUITE = `import { test, expect, unique } from 'e2e';

for (const n of ${JSON.stringify(REPETITIONS)}) {
  test('deterministic ' + n, async ({ app, screen }) => {
    await app.open('/companies/new');
    const name = 'E2E ' + String(Date.now()) + ' Company';
    await screen.getByLabel('Company name').fill(name);
    await screen.getByRole('button', { name: 'Create' }).click();
    await expect(screen.getByRole('heading', { name })).toBeVisible();
  });

  test('agent ' + n, async ({ app, agent, screen }) => {
    await app.open('/companies/new');
    const name = 'E2E ' + String(Date.now()) + ' Company';
    await agent.act('create a company named {name}', { params: { name: unique(name) } });
    await expect(screen.getByRole('heading', { name })).toBeVisible();
  });
}
`;

/** Types the name from the step parameters, taps Create, and concludes once the record page shows. */
function companyModel(): ModelInstance {
  return installFakeLoopModel((call) => {
    if (/"Company state" text="created"/u.test(call.lastToolResult)) {
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'created the company' } }];
    }
    if (call.lastToolResult !== '') throw new Error(`the company was not created:\n${call.lastToolResult}`);
    const params = JSON.parse(/^Step parameters:\n(.*)$/mu.exec(call.prompt)![1]!) as { name: string };
    const calls: LoopToolCall[] = [
      { toolName: 'type', input: { target: nodeIdFor(call.prompt, /textbox "Company name"/u), value: params.name } },
      { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Create"/u) } },
    ];
    return calls;
  });
}

/** The steps of one test's last attempt. */
function stepsOf(outcome: RunOutcome, title: string): StepRecord[] {
  const result = outcome.results.find((candidate) => candidate.test.title === title);
  if (result === undefined) throw new Error(`no result titled "${title}"; run errors: ${JSON.stringify(outcome.report.run.errors)}`);
  return result.attempts.at(-1)!.steps;
}

/** The flow's own steps: everything after `app.open`, the trailing expect included, since a replay checks its end state too. */
function flowMs(steps: readonly StepRecord[]): number {
  return steps.filter((step) => step.api !== 'app.open').reduce((total, step) => total + step.durationMs, 0);
}

/** The `agent.act` step among a test's steps. */
function actStep(steps: readonly StepRecord[]): StepRecord {
  const step = steps.find((candidate) => candidate.api === 'agent.act');
  if (step === undefined) throw new Error(`no agent.act step among ${steps.map((candidate) => candidate.api).join(', ')}`);
  return step;
}

/** Arithmetic mean, rounded to whole milliseconds. */
function mean(values: readonly number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

describe('trace cache: a replay runs at the speed of the deterministic API', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/speed.e2e.ts': SUITE });
    const options = () => ({
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model: companyModel() } }, cache: 'read-write' as const },
    });
    recorded = await runExisting(project, options());
    replayed = await runExisting(project, options());
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes both runs, recording on the first and replaying with no model call on the second', () => {
    expect(recorded.exitCode).toBe(0);
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    for (const n of REPETITIONS) {
      const step = actStep(stepsOf(replayed, `agent ${String(n)}`));
      expect(step.cache).toEqual({ mode: 'self-finalized', replayedActions: 2, totalActions: 2 });
      expect(step.metrics?.modelCalls).toBe(0);
    }
  });

  it('replays within the bound of the deterministic twin', () => {
    const deterministic = mean(REPETITIONS.map((n) => flowMs(stepsOf(replayed, `deterministic ${String(n)}`))));
    const record = mean(REPETITIONS.map((n) => actStep(stepsOf(recorded, `agent ${String(n)}`)).durationMs));
    const replay = mean(REPETITIONS.map((n) => actStep(stepsOf(replayed, `agent ${String(n)}`)).durationMs));
    const bound = Math.max(REPLAY_FLOOR_MS, REPLAY_RATIO * deterministic);
    console.info(
      `trace cache speed (mean of ${String(REPETITIONS.length)}): deterministic ${String(deterministic)} ms · record ${String(record)} ms · replay ${String(replay)} ms · bound ${String(bound)} ms`,
    );
    expect(replay, `replay ${String(replay)} ms against deterministic ${String(deterministic)} ms`).toBeLessThanOrEqual(bound);
  });
});
