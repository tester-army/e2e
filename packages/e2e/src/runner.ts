/**
 * In-process runner APIs. `list` collects and selects as `e2e list` does and
 * stops before any app, engine, or worker starts. `openHost` opens a reusable
 * worker whose per-test sessions share the runner's attempt lifecycle.
 * Importing `e2e` does not load this module.
 *
 * `ConfigurationError` is also on `e2e/engine`. A caller of `list` or
 * `openHost` matches `error.code` from here, without importing the engine
 * contract.
 */
export { ConfigurationError, isE2EError, type SerializedError } from './internal/errors.ts';
export { list, type ListOptions, type ListResult, type ListedPair } from './run/runner.ts';
export { openHost, type E2EHost, type E2ESession, type OpenHostOptions, type OpenSessionOptions } from './run/open-session.ts';
export type { StepProgress, StepRecord } from './run/steps.ts';
