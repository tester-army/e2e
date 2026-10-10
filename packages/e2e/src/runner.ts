/**
 * In-process runner APIs. `list` collects and selects as `e2e list` does and
 * stops before any app, engine, or worker starts. `openSession` opens one
 * attempt, the one `e2e mcp` opens, for a host running its own tests.
 * Importing `e2e` does not load this module.
 *
 * `ConfigurationError` is also on `e2e/engine`. A caller of `list` or
 * `openSession` matches `error.code` from here, without importing the engine
 * contract.
 */
export { ConfigurationError, isE2EError, type SerializedError } from './internal/errors.ts';
export { list, type ListOptions, type ListResult, type ListedPair } from './run/runner.ts';
export { openSession, type E2ESession, type OpenSessionOptions } from './run/open-session.ts';
export type { StepProgress, StepRecord } from './run/steps.ts';
