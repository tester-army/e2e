/** Public sdk-0.1 entrypoint. */

export { afterAll, afterEach, beforeAll, beforeEach, describe, test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials, secrets } from './secrets.ts';
export { defineService } from './services.ts';
export { unique } from './params.ts';
export { AgentError, isAgentError } from './agent/error.ts';
// The markdown page the `markdown` reporter writes, for a reporter that posts
// it elsewhere: @e2e-dev/github renders the pull request comment from it.
export { renderMarkdownReport } from './report/markdown.ts';
export type { MarkdownReportOptions } from './report/markdown.ts';

export type * from './types.ts';
export type {
  ExecutorActions,
  ExecutorAttempt,
  ExecutorBudgets,
  ExecutorModelCall,
  ExecutorNode,
  ExecutorObservation,
  ExecutorObserveOptions,
  ExecutorPixels,
  ExecutorStep,
  ExecutorTarget,
  ExecutorVerb,
  PointHit,
  PointTapResult,
  ReplayedPrefix,
  ReplayHandOffReason,
  StepExecutor,
  StepExecutorContext,
  StepVerdict,
  StepVerdictStatus,
} from './agent/executor.ts';
export type { StepTurn, VisionDegradation } from './run/steps.ts';
export type { RunEvent, RunEventOf, RunExitCode, RunStatus } from './run/events.ts';
export type { EngineAppDeclaration } from './engine/index.ts';
