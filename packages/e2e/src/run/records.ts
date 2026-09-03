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
  redaction: 'none' | 'complete';
  producer: ArtifactProducer;
}

export interface AttemptRecord {
  id: string;
  index: number;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
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
  memberTestIds: string[];
  status: 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  skip?: SkipInfo;
  attempts: SerialAttemptRecord[];
}

export type ResultStatus = 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

export interface ResultRecord {
  test: TestIdentity;
  target: ResolvedTarget;
  status: ResultStatus;
  selected: boolean;
  skip?: SkipInfo | undefined;
  attempts: AttemptRecord[];
  serialGroupId?: string;
}

export interface RunError {
  error: SerializedError;
}
