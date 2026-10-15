/**
 * What one result left behind, wherever the report keeps it. A serial
 * member's result carries no attempts of its own: its error, duration, and
 * steps live on the group's final attempt, keyed by test id. Every other
 * result answers from its own attempts. The reporters that read a result
 * (JUnit, markdown) share this one reading.
 */

import type { SkipInfo } from '../collect/select.ts';
import type { FailureEvidence } from '../run/records.ts';
import type { AppLogRecord } from '../run/steps.ts';
import type { ReportError, ReportResult, ReportSerialGroup, ReportStep } from './build.ts';

type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];

/** One attempt as a reporter reads it: what stopped it, the steps up to there, and what it left behind. */
export interface AttemptView {
  readonly status: ReportResult['attempts'][number]['status'] | 'skipped';
  readonly error: ReportError | undefined;
  readonly steps: readonly ReportStep[];
  /** What the app logged during the attempt (for a serial member, during its part of it), each line with its step. */
  readonly appLog: readonly AppLogRecord[];
  /** What the runner saw when the failure landed, when it captured anything. */
  readonly failure: FailureEvidence | undefined;
  /** The attempt's own artifacts; for a serial member, the group attempt's. */
  readonly artifacts: readonly ReportArtifact[];
  /** What else failed after the error: a teardown hook, the engine's cleanup. */
  readonly secondaryErrors: readonly ReportError[];
  /** What the engine said the attempt ran on; for a serial member, the group attempt's. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** Why the body skipped itself; on a failed attempt, a skip the failure outranked. */
  readonly skip: SkipInfo | undefined;
}

export interface Outcome {
  /** The final attempt's duration; for a serial member, the member's own. */
  readonly durationMs: number;
  /** The final attempt: the verdict of a failed test, the passing retry of a flaky one. */
  readonly final: AttemptView;
  /** The last attempt that did not pass before the final one, when there was one: what a flaky test hit. */
  readonly lastFailed: AttemptView | undefined;
  /** Every attempt in order, so a reporter can say whether they failed alike. */
  readonly attempts: readonly AttemptView[];
  /** Attempts that did not pass before the final one; what a flaky pass cost. */
  readonly failedAttempts: number;
}

/** What a result that never ran an attempt reads as. */
const NO_ATTEMPT: AttemptView = { status: 'skipped', error: undefined, steps: [], appLog: [], failure: undefined, artifacts: [], secondaryErrors: [], skip: undefined };

export function outcome(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): Outcome {
  const views = attemptViews(result, groups);
  const earlier = views.slice(0, -1);
  return {
    durationMs: durationOf(result, groups),
    final: views.at(-1) ?? NO_ATTEMPT,
    lastFailed: earlier.toReversed().find((attempt) => attempt.status !== 'passed'),
    attempts: views,
    failedAttempts: earlier.filter((attempt) => attempt.status !== 'passed').length,
  };
}

/** The result's attempts as views; a serial member's from its group, keyed by test id. */
function attemptViews(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): AttemptView[] {
  if (result.serialGroupId === undefined) {
    return result.attempts.map((attempt) => ({
      status: attempt.status,
      error: attempt.error,
      steps: attempt.steps,
      appLog: attempt.appLog ?? [],
      failure: attempt.failure,
      artifacts: attempt.artifacts,
      secondaryErrors: attempt.secondaryErrors,
      environment: attempt.environment,
      skip: attempt.skip,
    }));
  }
  const attempts = groups.get(result.serialGroupId)?.attempts ?? [];
  return attempts.map((attempt) => {
    const member = attempt.members.find((candidate) => candidate.testId === result.testId);
    return {
      status: member?.status ?? attempt.status,
      error: member?.error ?? attempt.error,
      steps: member?.steps ?? [],
      appLog: member?.appLog ?? [],
      failure: member?.failure,
      artifacts: attempt.artifacts,
      // The member's own, then the shared session's: its cleanup errors land on the group attempt.
      secondaryErrors: [...(member?.secondaryErrors ?? []), ...attempt.secondaryErrors],
      environment: attempt.environment,
      skip: member?.skip,
    };
  });
}

function durationOf(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): number {
  if (result.serialGroupId === undefined) return result.attempts.at(-1)?.durationMs ?? 0;
  const last = groups.get(result.serialGroupId)?.attempts.at(-1);
  return last?.members.find((candidate) => candidate.testId === result.testId)?.durationMs ?? 0;
}
