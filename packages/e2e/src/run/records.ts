/** Execution result data model shared by the executor and reporters. */

import type { SerializedError } from '../internal/errors.ts';
import type { TestIdentity } from '../collect/collect.ts';
import type { SkipInfo } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { StepRecord } from './steps.ts';

export type ArtifactProducer = { kind: 'step'; stepId: string } | { kind: 'attempt' };

export interface ArtifactRecord {
  id: string;
  kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log';
  mediaType: string;
  path?: string;
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
   * `complete`; a trace is `complete` once every registered secret value was
   * rewritten out of its text, and `not-required` when no secret was filled
   * on its session; a video is `incomplete`, since a recording masks nothing
   * (a secure field renders its own dots, but anything else the screen
   * showed is in the frames), and is kept as it is. report-1 also admits an
   * `incomplete` artifact without a `path`, one its producer withheld; this
   * runner never writes one.
   */
  redaction: 'complete' | 'not-required' | 'incomplete';
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
  /** The `log` artifact holding the redacted screen at failure, by id. */
  screen?: string;
  /** The masked `screenshot` artifact taken at failure, by id. */
  screenshot?: string;
  /** Screen lines of the nodes closest to what a failed locator asked for. */
  candidates?: string[];
}

export interface AttemptRecord {
  id: string;
  index: number;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
  failure?: FailureEvidence;
  /** Why the body skipped itself (`test.skip(condition, reason)`); set exactly when `status` is `skipped`. */
  skip?: SkipInfo;
  secondaryErrors: SerializedError[];
  cleanup: 'complete' | 'failed' | 'forced';
}

export interface SerialMemberRecord {
  id: string;
  index: number;
  testId: string;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
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
  memberTestIds: string[];
  status: 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  skip?: SkipInfo;
  attempts: SerialAttemptRecord[];
}

export type ResultStatus = 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

export interface ResultRecord {
  test: TestIdentity;
  target: ResolvedTarget;
  /** The configured agent the test ran as; with a test run as several, one record each. */
  agent: string;
  status: ResultStatus;
  selected: boolean;
  skip?: SkipInfo | undefined;
  attempts: AttemptRecord[];
  serialGroupId?: string;
}

export interface RunError {
  error: SerializedError;
}
