/**
 * Programmatic host surface (`e2e/run`): run the runner in-process and stream
 * structured events, without shelling out to the CLI. This is how an
 * embedding host — a hosted platform, a CI wrapper, an IDE — drives runs.
 *
 * The CLI is a thin consumer of exactly this surface; nothing here is
 * CLI-only. The surface is host tooling, not part of sdk-0.1: it can grow in
 * minors, and `report.json` (report-1) stays the canonical record of a run.
 */

export { run } from './runner.ts';
export type { RunOptions, RunOutcome } from './runner.ts';
export type {
  RunEvent,
  RunEventFact,
  RunEventHeader,
  RunEventResult,
  RunEventSink,
  RunExitCode,
} from './events.ts';
export type {
  ArtifactProducer,
  ArtifactRecord,
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  RunError,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from './records.ts';
export type {
  StepAgentDetails,
  StepCacheInfo,
  StepEvent,
  StepKind,
  StepMetrics,
  StepModelInfo,
  StepProgress,
  StepRecord,
} from './steps.ts';
export type { Report1Document } from '../report/build.ts';
// The shapes the records above are built from, so a host can name them
// directly (an error handler's parameter, a test-identity map key) without
// indexed-access gymnastics.
export type { ErrorCategory, ErrorPhase, SerializedError } from '../internal/errors.ts';
export type { TestIdentity } from '../collect/collect.ts';
export type { SkipInfo } from '../collect/select.ts';
