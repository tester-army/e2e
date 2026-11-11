/** Runner APIs live on e2e/runner so importing e2e does not load them; ConfigurationError is shared with e2e/engine. */
export { ConfigurationError, isE2EError, type SerializedError } from './internal/errors.ts';
export { list, type ListOptions, type ListResult, type ListedPair } from './run/runner.ts';
export { runSuite as run, type SuiteRunOptions as RunOptions, type RunResult } from './run/public-run.ts';
export {
  runExploration as explore,
  type ExplorationOptions as ExploreOptions,
  type ExplorationResult as ExploreResult,
} from './explore/public-explore.ts';
export type { RunEventSink } from './run/events.ts';
export { openHost, type E2EHost, type E2ESession, type OpenHostOptions, type OpenSessionOptions } from './run/open-session.ts';
export type { StepProgress, StepRecord } from './run/steps.ts';
