/** Public sdk-0.1 entrypoint. */

export { test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials, secrets } from './secrets.ts';
export { unique } from './params.ts';
export { AgentError, isAgentError } from './agent/error.ts';
// The markdown page the `markdown` reporter writes, for a reporter that posts
// it elsewhere: @e2edev/github renders the pull request comment from it.
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
  ReplayedPrefix,
  ReplayHandOffReason,
  StepExecutor,
  StepExecutorContext,
  StepVerdict,
  StepVerdictStatus,
} from './agent/executor.ts';
export type { VisionDegradation } from './run/steps.ts';
export type { RunEvent, RunEventOf } from './run/events.ts';
export type { EngineAppDeclaration } from './engine/index.ts';
