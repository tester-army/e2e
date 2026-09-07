/** Public sdk-0.1 entrypoint. */

export { test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials } from './credentials.ts';
export { AgentError } from './agent/error.ts';
export { BLOCKABLE_CODES, RUNTIME_CODES } from './agent/executor.ts';
// Entry framing for custom TraceCacheStore implementations: a remote store
// serializes buildTraceEntry(payload) on write and validates documents with
// readTraceEntry on read — the same framing the default file store uses.
export { buildTraceEntry, readTraceEntry } from './cache/trace.ts';

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
export type { EngineAppDeclaration } from './engine/index.ts';
