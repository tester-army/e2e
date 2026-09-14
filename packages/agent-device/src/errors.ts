/**
 * Translation of agent-device failures onto the engine error contract.
 *
 * | agent-device failure                                        | Code                         |
 * | ----------------------------------------------------------- | ---------------------------- |
 * | already an EngineError / runner error                       | passed through untouched     |
 * | AbortError                                                  | CANCELLED                    |
 * | no active session / session not found                       | INVALID_STATE                |
 * | UNSUPPORTED_OPERATION, NOT_IMPLEMENTED, UNSUPPORTED_PLATFORM | UNSUPPORTED_CAPABILITY      |
 * | "not supported on this device" under any code                | UNSUPPORTED_CAPABILITY       |
 * | a ref the daemon no longer knows (action paths only)        | NODE_STALE (retryable)       |
 * | timed out                                                   | OPERATION_TIMEOUT            |
 * | anything else                                               | ENGINE_FAILURE              |
 */

import { normalizeAgentDeviceError } from 'agent-device';
import { EngineError, ConfigurationError, InfrastructureError, TestError, raceAbort } from 'e2e/engine';
import { cancelled } from './support.ts';

/**
 * True for an error that already carries its classification: an `EngineError`
 * from any module copy, or a runner error. Those cross the boundary untouched;
 * re-wrapping one would turn a `POLICY_DENIED` into an infrastructure failure.
 */
function isClassified(cause: unknown): cause is Error {
  if (cause instanceof EngineError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && cause.name === 'EngineError';
}

/** A failure's message in agent-device's normalized form. */
export function message(cause: unknown): string {
  return normalizeAgentDeviceError(cause).message;
}

const NO_SESSION_PATTERN = /no active (?:app )?session|session\b.*\bnot found|open an app first|no app (?:is )?open/i;
const UNSUPPORTED_CODES = new Set(['UNSUPPORTED_OPERATION', 'NOT_IMPLEMENTED', 'UNSUPPORTED_PLATFORM']);
const UNSUPPORTED_PATTERN = /\b(?:is )?not supported\b|\bunsupported\b/i;
const TIMEOUT_PATTERN = /\btimed?\s?out\b/i;
const STALE_PATTERN =
  /\bref\b.*\b(?:not found|unknown|stale|no longer|expired|invalid|missing)|\b(?:not found|unknown|stale|no longer|expired|invalid|missing)\b.*\bref\b|refs?generation/i;

/** Translates an unexpected agent-device error at the contract boundary. */
export function translateError(cause: unknown, operation: string): Error {
  if (isClassified(cause)) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') return cancelled(`${operation} cancelled`);
  const normalized = normalizeAgentDeviceError(cause);
  const text = `${operation} failed: ${normalized.message}`;
  const options = { retryable: false, cause };
  if (normalized.code === 'SESSION_NOT_FOUND' || NO_SESSION_PATTERN.test(normalized.message)) {
    return new EngineError('INVALID_STATE', text, options);
  }
  if (UNSUPPORTED_CODES.has(normalized.code) || UNSUPPORTED_PATTERN.test(normalized.message)) {
    return new EngineError('UNSUPPORTED_CAPABILITY', text, options);
  }
  if (TIMEOUT_PATTERN.test(normalized.message)) return new EngineError('OPERATION_TIMEOUT', text, options);
  return new EngineError('ENGINE_FAILURE', text, options);
}

/**
 * Runs one agent-device command under an abort signal and translates its
 * failure onto the engine taxonomy: the one boundary every command crosses.
 */
export async function runCommand<T>(label: string, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await raceAbort(work, signal, label);
  } catch (cause) {
    throw translateError(cause, label);
  }
}

/**
 * Like translateError, but a ref the daemon no longer binds becomes retryable
 * `NODE_STALE`: nothing was dispatched, so the harness may re-observe and
 * re-resolve the node instead of failing the action.
 */
export function staleOr(cause: unknown, operation: string): Error {
  if (isClassified(cause)) return cause;
  const normalized = normalizeAgentDeviceError(cause);
  if (STALE_PATTERN.test(normalized.message)) {
    return new EngineError('NODE_STALE', `${operation}: ${normalized.message}`, { retryable: true, cause });
  }
  return translateError(cause, operation);
}
