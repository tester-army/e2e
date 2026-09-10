/**
 * One run of one arm on one track, scored from what it left on disk: the
 * report, the AI trace, and the `run.json` the runner wrote about the
 * process. Rescoring a directory later must give the same answer, so nothing
 * here depends on the process that produced it.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tableCostUsd, type Arm } from './catalog.ts';
import { readReport, reasoningTokensByTest } from './report-data.ts';
import { scoreExplore, type Adjudication, type ExploreScore } from './score-explore.ts';
import { scoreTests, type TaskRow } from './score-tests.ts';
import type { Track } from './tracks.ts';

/** What the runner records about the CLI process, independent of the report. */
export interface RunProcess {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly startedAt: string;
  /** Why the run never produced a report, when it did not. */
  readonly error?: string;
}

export interface RunUsage {
  readonly calls: number;
  readonly actions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  /** Provider-reported, summed over the steps that reported one; undefined when none did. */
  readonly costUsd: number | undefined;
  /** The same tokens at the arm's list price. */
  readonly tableCostUsd: number;
  readonly modelMs: number;
}

export interface RunScore {
  readonly arm: string;
  readonly track: Track['id'];
  readonly repeat: number;
  readonly dir: string;
  readonly process: RunProcess;
  /** The report's own verdict on the run; undefined without a report. */
  readonly runStatus: string | undefined;
  readonly tasks: readonly TaskRow[];
  readonly explore: ExploreScore | undefined;
  readonly usage: RunUsage;
}

export const RUN_PROCESS_FILE = 'run.json';

/** Scores the run in `dir`; a run without a report scores as empty with the process error kept. */
export function scoreRun(
  arm: Arm,
  track: Track,
  repeat: number,
  dir: string,
  adjudications: readonly Adjudication[],
): RunScore {
  const process = readProcess(dir);
  const written = readReport(dir);
  // A report that ran nothing and carries a run-level error (no tests matched,
  // the config failed to load) is a run that did not happen, not a zero score.
  const runError = written !== undefined && written.run.results.length === 0 ? written.run.errors[0] : undefined;
  const report = runError === undefined ? written : undefined;
  const tasks = report === undefined ? [] : scoreTests(report, reasoningTokensByTest(dir));
  const explore =
    report === undefined || track.oracle !== 'explore'
      ? undefined
      : scoreExplore(report, adjudications, track.id === 'explore-clean');
  const error =
    process.error ??
    (runError === undefined ? undefined : `${runError.code}: ${runError.message}`) ??
    (report === undefined ? 'the run wrote no report' : undefined);
  return {
    arm: arm.id,
    track: track.id,
    repeat,
    dir,
    process: error === undefined ? process : { ...process, error },
    runStatus: report?.run.status,
    tasks,
    explore,
    usage: usageOf(tasks, arm),
  };
}

function readProcess(dir: string): RunProcess {
  const file = path.join(dir, RUN_PROCESS_FILE);
  if (!existsSync(file)) return { exitCode: -1, durationMs: 0, startedAt: '', error: 'no run.json: the runner never started this run' };
  return JSON.parse(readFileSync(file, 'utf8')) as RunProcess;
}

function usageOf(tasks: readonly TaskRow[], arm: Arm): RunUsage {
  const sum = (pick: (task: TaskRow) => number): number => tasks.reduce((total, task) => total + pick(task), 0);
  const reported = tasks.filter((task) => task.costUsd !== undefined);
  const tokens = {
    inputTokens: sum((task) => task.inputTokens),
    outputTokens: sum((task) => task.outputTokens),
    cacheReadTokens: sum((task) => task.cacheReadTokens),
  };
  return {
    calls: sum((task) => task.calls),
    actions: sum((task) => task.actions),
    ...tokens,
    reasoningTokens: sum((task) => task.reasoningTokens),
    costUsd: reported.length === 0 ? undefined : reported.reduce((total, task) => total + (task.costUsd ?? 0), 0),
    tableCostUsd: tableCostUsd(arm.pricing, tokens),
    modelMs: sum((task) => task.modelMs),
  };
}
