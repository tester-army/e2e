/**
 * The `@e2edev/e2e/reporter` entrypoint: what a reporter package imports.
 * The `Reporter` contract itself is on the main entrypoint beside
 * `ArtifactStore`, so an inline reporter in `e2e.config.ts` needs nothing from
 * here; this subpath names the shapes a reporter reads — the run event stream
 * and the report document — so a package can type its handlers without
 * indexed-access gymnastics.
 */

export type { BuiltinReporter, FinishedRun, Report, Reporter, ReporterLinks } from '../types.ts';
export type {
  RunEvent,
  RunEventFact,
  RunEventHeader,
  RunEventOf,
  RunEventResult,
  RunExitCode,
  RunStatus,
  SetupStep,
} from '../run/events.ts';
export type {
  ArtifactProducer,
  ArtifactRecord,
  AttemptRecord,
  ResultStatus,
  RunError,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from '../run/records.ts';
export type {
  StepAgentDetails,
  StepCacheInfo,
  StepEvent,
  StepKind,
  StepMetrics,
  StepModelInfo,
  StepProgress,
  StepRecord,
} from '../run/steps.ts';
export type { ErrorCategory, ErrorPhase, SerializedError } from '../internal/errors.ts';
export type { TestIdentity } from '../collect/collect.ts';
export type { SkipInfo } from '../collect/select.ts';
