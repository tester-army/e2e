/**
 * One scripted fixture file through the real runner, once per describe: the
 * engine is the scripted engine over the reference scene, the budgets are
 * short enough for failing paths to fail fast, and the outcome is read by the
 * assertions that follow the `beforeAll`. Beside it, the attempt readers
 * those assertions share.
 */

import { afterAll, beforeAll, expect } from 'vitest';
import type { AttemptRecord } from '../../src/run/records.ts';
import { FAKE_APP_URL, type FakeEngineHandle } from './fake-engine.ts';
import { engineConfig } from './fixture-config.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from './run-project.ts';
import { createScriptedEngine, scene, type ScriptedEngineScript } from './scripted-engine.ts';

export interface ScriptedRun {
  readonly fake: FakeEngineHandle;
  readonly outcome: RunOutcome;
  readonly project: FixtureProject;
}

/**
 * Registers the `beforeAll` that runs `tests/<file>` with `source` against a
 * scripted engine over the reference scene, and the `afterAll` that cleans
 * the project up. The run is read through the handle once the hook ran.
 */
export function scriptedSuite(file: string, source: string, script: Omit<ScriptedEngineScript, 'scene'> = {}): ScriptedRun {
  let run: ScriptedRun | undefined;
  const ready = (): ScriptedRun => {
    if (run === undefined) throw new Error(`the scripted run of ${file} is read before its beforeAll finished`);
    return run;
  };
  beforeAll(async () => {
    const fake = createScriptedEngine({ scene, ...script });
    const { outcome, project } = await runProject(
      { [`tests/${file}`]: source },
      { appUrl: FAKE_APP_URL, config: engineConfig(fake.engine, { actionTimeout: 300, assertionTimeout: 200 }) },
    );
    run = { fake, outcome, project };
  }, 120_000);
  afterAll(() => run?.project.cleanup());
  return {
    get fake() {
      return ready().fake;
    },
    get outcome() {
      return ready().outcome;
    },
    get project() {
      return ready().project;
    },
  };
}

/** The passed attempt of one test; a failure prints the error the runner recorded. */
export function passed(outcome: RunOutcome, title: string): AttemptRecord {
  const result = resultByTitle(outcome, title);
  expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  return result.attempts[0]!;
}

/** The failed attempt of one test, its error code checked and every fragment found in the message. */
export function failed(outcome: RunOutcome, title: string, code: string, ...fragments: string[]): AttemptRecord {
  const result = resultByTitle(outcome, title);
  const attempt = result.attempts[0]!;
  expect(result.status, `${title}: ${JSON.stringify(attempt.error)}`).toBe('failed');
  expect(attempt.error?.code, attempt.error?.message).toBe(code);
  for (const fragment of fragments) expect(attempt.error?.message).toContain(fragment);
  return attempt;
}

/** The first step of an attempt recorded under `api`; a miss lists the apis the attempt did record. */
export function step(attempt: AttemptRecord, api: string) {
  const found = attempt.steps.find((candidate) => candidate.api === api);
  expect(found, `no step ${api} in ${attempt.steps.map((entry) => entry.api).join(', ')}`).toBeDefined();
  return found!;
}
