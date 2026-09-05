/** Execution result data model shared by the executor and reporters. */

import type { SerializedError } from '../internal/errors.ts';
import type { TestIdentity } from '../collect/collect.ts';
import type { SkipInfo } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { StepRecord } from './steps.ts';
import type { FailureClassification } from '../types.ts';

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

/**
 * What the runner captured the moment a test failure landed, while the screen
 * still showed it: pointers into the attempt's artifacts, plus the one fact an
 * analyzer needs that no artifact carries.
 */
export interface FailureEvidence {
  /** Artifact ID of the masked failure screenshot, when the backend produced one. */
  screenshot?: string;
  /** Artifact ID of the redacted semantic-tree snapshot, when the observation succeeded. */
  observation?: string;
  /** Redacted location as the failure landed, when the platform has one. */
  url?: string;
  /** True when a secret was filled during the attempt: pixels must not reach a model. */
  pixelsTainted: boolean;
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
  /** Present when a test failure landed with the session still open. */
  evidence?: FailureEvidence;
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
  /** Post-failure analysis, attached by the runner after the last attempt. */
  analysis?: FailureAnalysisRecord;
}

/**
 * How one failed pair was analyzed, as the report and the event stream carry
 * it. `analyzed` holds the verdict; `unavailable` says why there is none, so
 * a missing verdict is never silent.
 */
export type FailureAnalysisRecord =
  | {
      status: 'analyzed';
      analyzer: string;
      classification: FailureClassification;
      confidence: 'low' | 'medium' | 'high';
      summary: string;
      evidence: string[];
      suggestedFix?: string;
      /** Artifact IDs the analysis was given, so a reader can open what the analyzer saw. */
      artifacts: { screenshot?: string; observation?: string };
      /** Provenance and usage of the built-in analyzer's model call; absent for a custom analyzer. */
      model?: {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd?: number;
      };
      durationMs: number;
    }
  | {
      status: 'unavailable';
      analyzer: string;
      /** Closed reason set, so hosts can branch without parsing prose. */
      reason: 'no-model' | 'limit-reached' | 'failed' | 'timed-out' | 'interrupted';
      message: string;
      durationMs: number;
    };

/** The report-1 extension key a result's analysis is filed under (spec 13-reporting.md). */
export const ANALYSIS_EXTENSION_KEY = 'e2edev.analysis';

export interface RunError {
  error: SerializedError;
}
