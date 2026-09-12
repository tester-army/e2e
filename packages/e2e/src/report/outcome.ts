/**
 * What one result left behind, wherever the report keeps it. A serial
 * member's result carries no attempts of its own: its error, duration, and
 * steps live on the group's final attempt, keyed by test id. Every other
 * result answers from its own attempts. The reporters that read a result
 * (JUnit, markdown) share this one reading.
 */

import type { ReportError, ReportResult, ReportSerialGroup, ReportStep } from './build.ts';

type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];

/** One attempt as a reporter reads it: what stopped it, and the steps up to there. */
export interface AttemptView {
  readonly error: ReportError | undefined;
  readonly steps: readonly ReportStep[];
}

export interface Outcome {
  /** The final attempt's duration; for a serial member, the member's own. */
  readonly durationMs: number;
  /** The final attempt: the verdict of a failed test, the passing retry of a flaky one. */
  readonly final: AttemptView;
  /** The last attempt that did not pass before the final one, when there was one: what a flaky test hit. */
  readonly lastFailed: AttemptView | undefined;
  /** Attempts that did not pass before the final one; what a flaky pass cost. */
  readonly failedAttempts: number;
  /** The evidence over every attempt: a flaky test's failure screenshot belongs to the attempt that failed. */
  readonly artifacts: readonly ReportArtifact[];
}

export function outcome(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): Outcome {
  if (result.serialGroupId === undefined) {
    const attempts = result.attempts;
    const earlier = attempts.slice(0, -1);
    const lastFailed = earlier.toReversed().find((attempt) => attempt.status !== 'passed');
    return {
      durationMs: attempts.at(-1)?.durationMs ?? 0,
      final: { error: attempts.at(-1)?.error, steps: attempts.at(-1)?.steps ?? [] },
      lastFailed: lastFailed === undefined ? undefined : { error: lastFailed.error, steps: lastFailed.steps },
      failedAttempts: earlier.filter((attempt) => attempt.status !== 'passed').length,
      artifacts: attempts.flatMap((attempt) => attempt.artifacts),
    };
  }
  const attempts = groups.get(result.serialGroupId)?.attempts ?? [];
  const earlier = attempts.slice(0, -1);
  const memberOf = (attempt: ReportSerialGroup['attempts'][number] | undefined) =>
    attempt?.members.find((candidate) => candidate.testId === result.testId);
  const last = attempts.at(-1);
  const member = memberOf(last);
  const lastFailedAttempt = earlier.toReversed().find((attempt) => attempt.status !== 'passed');
  const lastFailedMember = memberOf(lastFailedAttempt);
  return {
    durationMs: member?.durationMs ?? 0,
    final: { error: member?.error ?? last?.error, steps: member?.steps ?? [] },
    lastFailed:
      lastFailedAttempt === undefined ? undefined : { error: lastFailedMember?.error ?? lastFailedAttempt.error, steps: lastFailedMember?.steps ?? [] },
    failedAttempts: earlier.filter((attempt) => attempt.status !== 'passed').length,
    artifacts: attempts.flatMap((attempt) => attempt.artifacts),
  };
}
