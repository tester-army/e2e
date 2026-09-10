/**
 * Scores a `run` report test by test: outcome, why it failed, and what it
 * cost. The act track reads the outcome as is; the judgment track adds the
 * confusion-matrix cell the outcome falls in, from the `bug:` / `clean:`
 * prefix the judgment suite puts on its titles.
 */

import type { AttemptRecord, Report, TestRecord } from './report-data.ts';

export interface TaskRow {
  /** Stable task id: the file and the full title, which the manifest keys on. */
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** The error code of the attempt that decided the outcome; undefined on a pass or a skip. */
  readonly code: string | undefined;
  readonly calls: number;
  readonly actions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  /** Provider-reported cost, undefined when no call reported one. */
  readonly costUsd: number | undefined;
  readonly durationMs: number;
  /**
   * Step time not spent in harness work: the step's duration minus its
   * observation, engine, and policy events. The model events bracket a whole
   * turn, tool execution included, so this difference is the closer measure
   * of provider latency.
   */
  readonly modelMs: number;
}

export type JudgmentOutcome = 'caught' | 'missed' | 'false-alarm' | 'correct' | 'inconclusive';

/** Every test of the report as a row, skips included (they count as harness coverage, not model failures). */
export function scoreTests(report: Report, reasoning: ReadonlyMap<string, number>): TaskRow[] {
  return report.run.results.map((test) => taskRow(test, reasoning.get(test.testId) ?? 0));
}

function taskRow(test: TestRecord, reasoningTokens: number): TaskRow {
  const attempt = test.attempts.at(-1);
  const usage = attempt === undefined ? emptyUsage() : attemptUsage(attempt);
  // The attempt's code names what ended the test (a timed-out test reads
  // TEST_TIMEOUT, not the CANCELLED its step was left with); the step's code
  // is the fallback when the attempt recorded none.
  const failedStep = attempt?.steps.find((step) => step.status !== 'passed' && step.error !== undefined);
  return {
    id: `${test.file}#${test.titlePath.join(' > ')}`,
    title: test.titlePath.at(-1) ?? '',
    status: test.status,
    code: test.status === 'passed' || test.status === 'skipped' ? undefined : (attempt?.error?.code ?? failedStep?.error?.code),
    ...usage,
    reasoningTokens,
    durationMs: attempt?.durationMs ?? 0,
  };
}

interface AttemptUsage {
  readonly calls: number;
  readonly actions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number | undefined;
  readonly modelMs: number;
}

function emptyUsage(): AttemptUsage {
  return { calls: 0, actions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: undefined, modelMs: 0 };
}

function attemptUsage(attempt: AttemptRecord): AttemptUsage {
  let usage = emptyUsage();
  for (const step of attempt.steps) {
    const harnessMs = step.events.filter((event) => event.kind !== 'model').reduce((sum, event) => sum + event.durationMs, 0);
    const modelMs = Math.max(0, step.durationMs - harnessMs);
    usage = {
      calls: usage.calls + (step.metrics?.modelCalls ?? 0),
      actions: usage.actions + (step.metrics?.actionSteps ?? 0),
      inputTokens: usage.inputTokens + (step.model?.inputTokens ?? 0),
      outputTokens: usage.outputTokens + (step.model?.outputTokens ?? 0),
      cacheReadTokens: usage.cacheReadTokens + (step.model?.cacheReadTokens ?? 0),
      costUsd:
        step.model?.estimatedCostUsd === undefined ? usage.costUsd : (usage.costUsd ?? 0) + step.model.estimatedCostUsd,
      modelMs: usage.modelMs + modelMs,
    };
  }
  return usage;
}

/**
 * The confusion-matrix cell of a judgment-track row. A `bug:` test asserts
 * correct behavior on a broken page: a failed assertion caught the bug, a
 * pass missed it. A `clean:` test asserts a true statement: a pass is
 * correct, a failed assertion a false alarm. Anything else that failed never
 * reached the judgment. Rows without a prefix are not judgment rows.
 */
export function judgmentOutcome(row: TaskRow): JudgmentOutcome | undefined {
  const bug = row.title.startsWith('bug:');
  const clean = row.title.startsWith('clean:');
  if (!bug && !clean) return undefined;
  if (row.status === 'passed') return bug ? 'missed' : 'correct';
  if (row.code === 'ASSERTION_FAILED') return bug ? 'caught' : 'false-alarm';
  // An act that named the bug on its way is a catch too: the model saw it.
  if (bug && row.code === 'ACTION_FAILED') return 'caught';
  return 'inconclusive';
}
