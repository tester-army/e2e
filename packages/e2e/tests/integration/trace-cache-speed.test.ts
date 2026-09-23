/**
 * How fast a trace replay is against the deterministic API it stands in for.
 * One flow, three ways, on the fixture app: `locator.fill` and `locator.click`
 * as a test would write them, the same flow as an `agent.act` recorded through
 * a scripted model, and that recording replayed with no model call. Both sides
 * are measured alike, as the whole flow after `app.open` with its trailing
 * assertion, from the report's step timings, and the fastest repetition after
 * the first stands for each: the first pays for the warm-up, and a loaded
 * runner slows any single one. The gate is a small factor of the twin plus a
 * ceiling well above what a healthy replay takes; like the other PR gates, it
 * catches a replay that stopped being cheap, not a benchmark regression.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { cacheConfig, flowByTitle, flowsModel, flowsSuite, onlyActStep } from '../helpers/trace-cache.ts';

const REPETITIONS = [1, 2, 3, 4] as const;
/** A replay may take this many times its deterministic twin. */
const REPLAY_RATIO = 3;
/** And never longer than this, whatever the twin took: an order of magnitude above a healthy replay. */
const REPLAY_CEILING_MS = 2_000;

const company = flowByTitle('creates a company');

/** The company flow as a test writes it by hand. */
const DETERMINISTIC_BODY = `  const name = 'E2E ' + String(Date.now()) + ' Company';
  await screen.getByLabel('Company name').fill(name);
  await screen.getByRole('button', { name: 'Create' }).click();
  await expect(screen.getByRole('heading', { name })).toBeVisible();`;

const SUITE = flowsSuite(
  REPETITIONS.flatMap((n) => [
    { title: `deterministic ${String(n)}`, open: company.open, body: DETERMINISTIC_BODY },
    { title: `agent ${String(n)}`, open: company.open, body: company.body },
  ]),
  'record',
);

/** The flow's own time: every step after `app.open`, the trailing expect included, since a replay checks its end state too. */
function flowMs(outcome: RunOutcome, title: string): number {
  return resultByTitle(outcome, title)
    .attempts.at(-1)!
    .steps.filter((step) => step.api !== 'app.open')
    .reduce((total, step) => total + step.durationMs, 0);
}

/** The fastest repetition after the first. */
function fastest(outcome: RunOutcome, prefix: string): number {
  return Math.min(...REPETITIONS.slice(1).map((n) => flowMs(outcome, `${prefix} ${String(n)}`)));
}

describe('trace cache: a replay runs at the speed of the deterministic API', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/speed.e2e.ts': SUITE });
    recorded = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) });
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes both runs, recording on the first and replaying with no model call on the second', () => {
    expect(recorded.exitCode).toBe(0);
    expect(replayed.exitCode).toBe(0);
    for (const n of REPETITIONS) {
      const step = onlyActStep(replayed, `agent ${String(n)}`);
      expect(step.cache).toEqual({ mode: 'self-finalized', replayedActions: 2, totalActions: 2 });
      expect(step.metrics?.modelCalls).toBe(0);
    }
  });

  it('replays within a small factor of the deterministic twin, under the ceiling, and faster than it recorded', () => {
    const deterministic = fastest(replayed, 'deterministic');
    const record = fastest(recorded, 'agent');
    const replay = fastest(replayed, 'agent');
    const numbers =
      `deterministic ${String(deterministic)} ms · record ${String(record)} ms · replay ${String(replay)} ms · ` +
      `ratio ${(replay / deterministic).toFixed(2)} (bound ${String(REPLAY_RATIO)}) · ceiling ${String(REPLAY_CEILING_MS)} ms`;
    console.info(`trace cache speed (fastest of ${String(REPETITIONS.length - 1)} after warm-up): ${numbers}`);
    expect(replay, numbers).toBeLessThanOrEqual(REPLAY_RATIO * deterministic);
    expect(replay, numbers).toBeLessThanOrEqual(REPLAY_CEILING_MS);
    expect(replay, numbers).toBeLessThanOrEqual(record);
  });
});
