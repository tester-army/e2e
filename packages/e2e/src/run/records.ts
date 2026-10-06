/** Execution result data model shared by the executor and reporters. */

import type { SerializedError } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { TestIdentity } from '../collect/collect.ts';
import type { SkipInfo } from '../collect/select.ts';
import { keeps, type Keep } from '../internal/recording-modes.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { AppLogRecord, StepRecord } from './steps.ts';

export type ArtifactProducer = { kind: 'step'; stepId: string } | { kind: 'attempt' };

export interface ArtifactRecord {
  id: string;
  kind: 'screenshot' | 'video' | 'download' | 'log';
  mediaType: string;
  path?: string;
  /** A video a hosted service keeps: the `http(s)` URL the report links to, in place of a local `path`. */
  url?: string;
  size?: number;
  sha256?: string;
  /** The configured `ArtifactStore`'s reference for this artifact, when one accepted it. */
  ref?: string;
  /**
   * When a time-based artifact began recording: a video segment's first frame
   * is at or just after this instant, so `step.startedAt - artifact.startedAt`
   * is the step's offset into it.
   */
  startedAt?: string;
  /**
   * Mirrors report-1: how much of the file the runner masked. A screenshot is
   * `complete`; a video is `incomplete`, since a recording masks nothing
   * (a secure field renders its own dots, but anything else the screen
   * showed is in the frames), and is kept as it is; a download is
   * `incomplete` too, bytes the app served and the runner did not rewrite,
   * unless the file is text the session's ledger was run over, which makes
   * it `complete`. report-1 also admits an
   * `incomplete` artifact without a `path`: a video a hosted service keeps,
   * recorded by `url`, or one its producer withheld, which this runner never
   * writes.
   */
  redaction: 'complete' | 'incomplete';
  producer: ArtifactProducer;
}

/**
 * What the runner saw the moment an attempt's failure landed, captured while
 * the session was still open: where the app was, the screen as the model
 * would read it (a `log` artifact), a masked screenshot when pixels were
 * allowed, and for a locator that matched nothing, the nodes on screen
 * closest to what it asked for. Best-effort: any field may be absent.
 */
export interface FailureEvidence {
  url?: string;
  /** The viewport the screen at failure was captured in. */
  viewport?: { width: number; height: number };
  /** Nodes the screen at failure listed; absent when it had no tree. */
  nodes?: number;
  /** The `log` artifact holding the redacted screen at failure, its listing alone, by id. */
  screen?: string;
  /** The masked `screenshot` artifact taken at failure, by id. */
  screenshot?: string;
  /** Screen lines of the nodes closest to what a failed locator asked for. */
  candidates?: string[];
}

export interface AttemptRecord {
  id: string;
  index: number;
  status: AttemptStatus;
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  /** What the app logged during the attempt, each line with its step; absent when it logged nothing. */
  appLog?: AppLogRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
  failure?: FailureEvidence;
  /** Why the body skipped itself (`test.skip(condition, reason)`); set exactly when `status` is `skipped`. */
  skip?: SkipInfo;
  secondaryErrors: SerializedError[];
  /** What the engine said the attempt ran on (`EngineAttemptContext.environment`), redacted. */
  environment?: Record<string, string>;
  /** Which of the attempt's outcomes keep a trace (`keeps`), when it keeps one at all; the runner's, never in the report. */
  trace?: Keep | undefined;
  cleanup: 'complete' | 'failed' | 'forced';
}

export interface SerialMemberRecord {
  id: string;
  index: number;
  testId: string;
  status: AttemptStatus;
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  /** What the app logged during the attempt, each line with its step; absent when it logged nothing. */
  appLog?: AppLogRecord[];
  error?: SerializedError;
  /** What the runner saw when this member's failure landed; see `FailureEvidence`. */
  failure?: FailureEvidence;
  skip?: SkipInfo;
  secondaryErrors: SerializedError[];
}

export interface SerialAttemptRecord {
  id: string;
  index: number;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  startedAt: string;
  durationMs: number;
  members: SerialMemberRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
  secondaryErrors: SerializedError[];
  /** What the engine said the attempt ran on (`EngineAttemptContext.environment`), redacted. */
  environment?: Record<string, string>;
  /** Which of the attempt's outcomes keep a trace (`keeps`), when it keeps one at all; the runner's, never in the report. */
  trace?: Keep | undefined;
  cleanup: 'complete' | 'failed' | 'forced';
}

export interface SerialGroupRecord {
  id: string;
  serialId: string;
  declarationIndex: number;
  file: string;
  titlePath: string[];
  targetId: string;
  platform: string;
  /** The configured agent this variant of the group ran as. */
  agent: string;
  /** Which run of the group this is under `--repeat-each`, 0 for the first. */
  repeat: number;
  memberTestIds: string[];
  status: 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  skip?: SkipInfo;
  attempts: SerialAttemptRecord[];
}

export type ResultStatus = 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

/** How one attempt of a test or serial member ended. */
export type AttemptStatus = 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

/** The statuses that mean something went wrong; a pass and a self-skip are both verdicts. */
export type FailedStatus = Exclude<AttemptStatus, 'passed' | 'skipped'>;

/**
 * Whether a status is a failure: the one question the runner asks of a
 * verdict before discarding a suite realm, ending a serial group, spending a
 * retry, or keeping a recording. A body that skipped itself is not one.
 */
export function isFailedStatus(status: AttemptStatus | ResultStatus): status is FailedStatus {
  return status !== 'passed' && status !== 'skipped' && status !== 'flaky';
}

/** Whether an attempt keeps its trace, by the rule its video follows too (`keeps`). */
function keepsTrace(attempt: Pick<AttemptRecord, 'status' | 'trace'>): boolean {
  return attempt.trace !== undefined && keeps(attempt.trace, attempt.status);
}

/** The report ids of the results that keep a trace page: those with an attempt that kept a trace; a serial member's attempts are its group's. */
export function tracedResultIds(results: readonly ResultRecord[], serialGroups: readonly SerialGroupRecord[]): Set<string> {
  const groups = new Map(serialGroups.map((group) => [group.id, group]));
  const traced = new Set<string>();
  for (const result of results) {
    const attempts = result.serialGroupId === undefined ? result.attempts : (groups.get(result.serialGroupId)?.attempts ?? []);
    if (attempts.some(keepsTrace)) traced.add(resultId(result.test.id, result.target.name, result.agent, result.repeat));
  }
  return traced;
}

export interface ResultRecord {
  test: TestIdentity;
  target: ResolvedTarget;
  /** The configured agent the test ran as; with a test run as several, one record each. */
  agent: string;
  /** Which run of the test this is under `--repeat-each`, 0 for the first; one record each. */
  repeat: number;
  status: ResultStatus;
  selected: boolean;
  skip?: SkipInfo | undefined;
  attempts: AttemptRecord[];
  serialGroupId?: string;
}

/**
 * `ResultRecord` minus the live target: what crosses the worker channel and
 * what reporters see. Serializable as-is: `test` is a `TestIdentity` and
 * every other field is plain data.
 */
export type WireResultRecord = Omit<ResultRecord, 'target'>;

/** The failure a runtime skip followed, with the evidence its attempt captured. */
export interface FailureBeforeSkip {
  readonly error: SerializedError;
  readonly failure: FailureEvidence | undefined;
  /** The failing attempt's artifacts; for a serial member, the group attempt's. */
  readonly artifacts: readonly ArtifactRecord[];
}

/**
 * The failure a test's `test.skip(...)` followed: the last attempt that
 * failed before a skipped retry, or a soft failure the skipping attempt kept.
 * Engine cleanup diagnostics after the skip are not one. A serial member's
 * attempts live on its group, which `groupOf` looks up only for such a member.
 */
export function failureBeforeSkip(
  result: Pick<ResultRecord, 'status' | 'skip' | 'attempts' | 'serialGroupId' | 'test'>,
  groupOf: (id: string) => SerialGroupRecord | undefined,
): FailureBeforeSkip | undefined {
  if (result.status !== 'skipped' || result.skip?.cause !== 'explicit') return undefined;
  const runs =
    result.serialGroupId === undefined
      ? result.attempts
      : (groupOf(result.serialGroupId)?.attempts ?? []).flatMap((attempt) =>
          attempt.members
            .filter((member) => member.testId === result.test.id)
            .map((member) => ({ ...member, artifacts: attempt.artifacts })),
        );
  for (const run of runs.toReversed()) {
    const error = run.error ?? run.secondaryErrors.find((secondary) => secondary.phase !== 'cleanup');
    if (error !== undefined) return { error, failure: run.failure, artifacts: run.artifacts };
  }
  return undefined;
}

/** Whether any skipped result followed a failure: what `failOnSkippedFailure` fails a run for. */
export function someSkippedAfterFailure(
  results: readonly ResultRecord[],
  serialGroups: readonly SerialGroupRecord[],
): boolean {
  const groups = new Map(serialGroups.map((group) => [group.id, group]));
  return results.some((result) => failureBeforeSkip(result, (id) => groups.get(id)) !== undefined);
}

/** Strips the live target from a result for transport. */
export function encodeResult(record: ResultRecord): WireResultRecord {
  const { target: _target, ...rest } = record;
  return rest;
}

export interface RunError {
  error: SerializedError;
}
