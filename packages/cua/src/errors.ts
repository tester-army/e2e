/**
 * Translation of Cua Driver failures onto the engine error contract.
 *
 * | Cua Driver outcome                                              | Code                          |
 * | --------------------------------------------------------------- | ----------------------------- |
 * | already an EngineError / runner error                           | passed through untouched      |
 * | AbortError                                                      | CANCELLED                     |
 * | tool error `stale_element_token`, `snapshot_id_required`        | NODE_STALE (retryable)        |
 * | tool error `window_id_not_found`, `window_owner_pid_mismatch`,  |                               |
 * |   `ambiguous_window_target`, `app_not_running`                  | INVALID_STATE                 |
 * | tool error naming a missing Accessibility / Screen Recording grant | ENGINE_FAILURE with the remedy |
 * | a structured refusal (`background_*`, `refused`, `unsupported`)  | NOT_ACTIONABLE / UNSUPPORTED  |
 * | `DriverError.Shutdown`                                          | INVALID_STATE                 |
 * | `DriverError.ActionInterrupted`, an action effect of `partial`  | ACTION_MAY_HAVE_COMMITTED     |
 * | anything else                                                   | ENGINE_FAILURE                |
 */

import { EngineError, ConfigurationError, InfrastructureError, TestError } from '@e2edev/e2e/engine';
import type { DriverToolResult } from './client.ts';
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

/** A failure's message, whatever shape the native binding threw it in. */
function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

const STALE_CODES = new Set(['stale_element_token', 'snapshot_id_required', 'stale_snapshot', 'element_not_found']);
const WINDOW_CODES = new Set([
  'window_id_not_found',
  'window_owner_pid_mismatch',
  'ambiguous_window_target',
  'app_not_running',
  'process_not_found',
  'no_window',
]);
const REFUSAL_CODES = new Set(['background_unavailable', 'background_occluded', 'refused', 'not_actionable', 'element_not_actionable']);
const UNSUPPORTED_CODES = new Set(['unsupported', 'unsupported_action', 'unsupported_platform', 'not_implemented']);
const PERMISSION_PATTERN = /\baccessibility\b.*\b(?:not granted|denied|permission)|\bscreen recording\b.*\b(?:not granted|denied)|\bTCC\b|\bpermission denied\b/i;
const STALE_PATTERN = /\bstale\b|\bsnapshot_id\b.*\brequired\b|\bsuperseded\b/i;
const TIMEOUT_PATTERN = /\btimed?\s?out\b/i;

/** The remedy a missing macOS grant needs, in the words System Settings uses. */
export const PERMISSION_REMEDY =
  'grant Accessibility (and Screen Recording for screenshots) to the process that runs the tests in System Settings > Privacy & Security, or run the tests from a terminal that already has the grants';

/** Translates a tool result that reported `isError` at the contract boundary. */
export function translateToolError(result: DriverToolResult, operation: string): EngineError {
  const code = (result.errorCode ?? '').toLowerCase();
  const text = `${operation} failed: ${result.text.trim() || result.errorCode || 'Cua Driver reported an error'}`;
  const options = { retryable: false };
  if (STALE_CODES.has(code) || (code === '' && STALE_PATTERN.test(result.text))) {
    return new EngineError('NODE_STALE', `${operation}: ${result.text.trim() || 'element token is stale'}`, { retryable: true });
  }
  if (WINDOW_CODES.has(code)) return new EngineError('INVALID_STATE', text, options);
  if (REFUSAL_CODES.has(code)) return new EngineError('NOT_ACTIONABLE', text, options);
  if (UNSUPPORTED_CODES.has(code)) return new EngineError('UNSUPPORTED_CAPABILITY', text, options);
  if (PERMISSION_PATTERN.test(result.text) || code.includes('permission')) {
    return new EngineError('ENGINE_FAILURE', `${text}; ${PERMISSION_REMEDY}`, options);
  }
  if (TIMEOUT_PATTERN.test(result.text)) return new EngineError('OPERATION_TIMEOUT', text, options);
  return new EngineError('ENGINE_FAILURE', text, options);
}

/** Translates an exception the native binding threw. */
export function translateThrown(cause: unknown, operation: string): Error {
  if (isClassified(cause)) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') return cancelled(`${operation} cancelled`);
  const detail = message(cause);
  const variant = cause instanceof Error ? `${cause.constructor.name} ${cause.name} ${cause.message}` : detail;
  const text = `${operation} failed: ${detail}`;
  const options = { retryable: false, cause };
  if (/shutdown/i.test(variant)) return new EngineError('INVALID_STATE', text, options);
  if (/actioninterrupted/i.test(variant)) return new EngineError('ACTION_MAY_HAVE_COMMITTED', text, options);
  if (TIMEOUT_PATTERN.test(detail)) return new EngineError('OPERATION_TIMEOUT', text, options);
  return new EngineError('ENGINE_FAILURE', text, options);
}

/** The `effect` an action tool reported, from the typed record or the structured JSON. */
function actionEffect(result: DriverToolResult): string | undefined {
  const fromRecord = readEffect(result.action);
  if (fromRecord !== undefined) return fromRecord;
  if (result.structuredJson === undefined) return undefined;
  try {
    const parsed = JSON.parse(result.structuredJson) as { action?: unknown; effect?: unknown };
    return readEffect(parsed.action) ?? readEffect(parsed);
  } catch {
    return undefined;
  }
}

function readEffect(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const effect = (record as { effect?: unknown }).effect;
  if (typeof effect === 'string') return effect.toLowerCase();
  if (typeof effect === 'number') return undefined;
  if (typeof effect === 'object' && effect !== null) {
    const tag = (effect as { tag?: unknown; kind?: unknown }).tag ?? (effect as { kind?: unknown }).kind;
    return typeof tag === 'string' ? tag.toLowerCase() : undefined;
  }
  return undefined;
}

/**
 * Judges a completed action. A `partial` effect means some input reached the
 * app and some did not: the harness must never repeat it blindly. A `refused`
 * effect means the driver declined to act on this surface, which is the
 * node's problem, not the run's.
 */
export function checkActionOutcome(result: DriverToolResult, operation: string): void {
  if (result.isError) throw translateToolError(result, operation);
  const effect = actionEffect(result);
  if (effect === 'partial') {
    throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `${operation}: the driver delivered part of the input`, {
      retryable: false,
    });
  }
  if (effect === 'refused') {
    throw new EngineError('NOT_ACTIONABLE', `${operation}: ${result.text.trim() || 'the driver refused the action'}`, {
      retryable: false,
    });
  }
}
