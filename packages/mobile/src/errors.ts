/**
 * Translation of agent-device failures onto the engine error contract.
 *
 * | agent-device failure                                        | Code                         |
 * | ----------------------------------------------------------- | ---------------------------- |
 * | already an EngineError / runner error                       | passed through untouched     |
 * | AbortError                                                  | CANCELLED                    |
 * | no active session / session not found / requires a session  | INVALID_STATE                |
 * | UNSUPPORTED_OPERATION, NOT_IMPLEMENTED, UNSUPPORTED_PLATFORM | UNSUPPORTED_CAPABILITY      |
 * | "not supported on this device" under any code                | UNSUPPORTED_CAPABILITY       |
 * | a ref the daemon no longer knows (action paths only)        | NODE_STALE (retryable)       |
 * | the iOS runner busy, wedged, or past its watchdog           | ENGINE_FAILURE, naming the   |
 * | a snapshot the iOS runner acquired but could not present    |   runner and the recovery    |
 * | anything else, agent-device's own timeouts included         | ENGINE_FAILURE with the text |
 *
 * `OPERATION_TIMEOUT` is never produced here. In the contract it means the
 * harness budget expired, which `raceAbort` already reports, and core
 * replaces its message with a bare `operation timed out`. A timeout
 * agent-device itself reports (a simulator boot, the runner connecting, an
 * app launch) is a device-side fault whose text is the diagnosis, so it
 * stays `ENGINE_FAILURE` and keeps its message and hint.
 */

import { isAgentDeviceError, normalizeAgentDeviceError } from 'agent-device';
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

/** The details bag the failure itself declared; the normalizer lifts some keys off it, so it is read raw. */
function details(cause: unknown): Record<string, unknown> {
  return isAgentDeviceError(cause) ? (cause.details ?? {}) : {};
}

/**
 * The normalized message followed by the hint the failure itself declared.
 * That hint is the recovery path (press return, tap the app's own Done
 * control) and the model only ever sees the error text, so dropping it leaves
 * the agent retrying the same refused action. The per-code default hint the
 * normalizer would add is CLI advice and stays out.
 */
function withHint(cause: unknown, text: string): string {
  const hint = details(cause).hint;
  if (typeof hint !== 'string' || hint.trim() === '' || CLI_ADVICE.test(hint)) return text;
  return `${text} Hint: ${hint.trim()}`;
}

/** agent-device's generic hint (`Check command arguments and run --help`) is CLI advice, and stays out too. */
const CLI_ADVICE = /--help|command arguments/i;

const NO_SESSION_PATTERN =
  /no active (?:app )?session|requires an active session|session\b.*\bnot found|open an app first|no app (?:is )?open/i;
const UNSUPPORTED_CODES = new Set(['UNSUPPORTED_OPERATION', 'NOT_IMPLEMENTED', 'UNSUPPORTED_PLATFORM']);
const UNSUPPORTED_PATTERN = /\b(?:is )?not supported\b|\bunsupported\b/i;
const STALE_PATTERN =
  /\bref\b.*\b(?:not found|unknown|stale|no longer|expired|invalid|missing)|\b(?:not found|unknown|stale|no longer|expired|invalid|missing)\b.*\bref\b|refs?generation/i;

/**
 * What the iOS automation runner reported about itself, by the code
 * agent-device emits for it: `RUNNER_WEDGED` at the top level, `RUNNER_BUSY`
 * and `MAIN_THREAD_TIMEOUT` in `details.runnerErrorCode` under
 * `COMMAND_FAILED`, the shape the daemon folds runner wire codes into. Each
 * value is the headline and the first move; the app is fine in every case.
 */
const RUNNER_STATE: ReadonlyMap<string, { readonly headline: string; readonly firstMove: string }> = new Map([
  [
    'RUNNER_BUSY',
    {
      headline: 'the iOS automation runner is still finishing a command that overran its watchdog',
      firstMove: 'Wait a few seconds and rerun.',
    },
  ],
  [
    'MAIN_THREAD_TIMEOUT',
    {
      headline: "the iOS automation runner's main thread overran its watchdog on this command",
      firstMove: 'Rerun once it has drained.',
    },
  ],
  [
    'RUNNER_WEDGED',
    {
      headline: 'the iOS automation runner is wedged: its main thread is stuck in abandoned work',
      firstMove: 'agent-device restarts the runner; rerun.',
    },
  ],
]);

/**
 * A snapshot the iOS runner acquired but could not present. Upstream raises
 * it as `IOS_SNAPSHOT_ENGINE_FAILED` and rethrows it to the client as
 * `COMMAND_FAILED` with the check that failed in `details.reason`: a
 * per-capture presentation check, not a property of the app or the screen.
 * The reasons are agent-device's (`ios-snapshot-runtime`,
 * `runner-presentation`): the viewport checks, a malformed graph, which the
 * presenter rewraps as `invalid-presented-payload` on the presented tree and
 * `invalid-quality-payload` on the quality tree, and the payload checks it
 * raises as `invalid-presented-payload` directly (a parent outside the
 * payload, a disabled or off-viewport node marked actionable).
 */
const PRESENTATION_CODE = 'IOS_SNAPSHOT_ENGINE_FAILED';
const PRESENTATION_REASONS = new Set([
  'invalid-viewport',
  'missing-viewport',
  'malformed-graph',
  'invalid-presented-payload',
  'invalid-quality-payload',
]);
const PRESENTATION = {
  headline: 'the iOS automation runner could not present the accessibility snapshot',
  firstMove: 'Rerun.',
};

const RUNNER_RECOVERY =
  'If the next run meets it again, stop the daemon (`npx agent-device daemon stop`) and reboot the simulator (`xcrun simctl shutdown <udid>`, then `boot`).';

/** The runner-state entry for a failure, by top-level code or the folded runner wire code. */
function runnerState(cause: unknown): { readonly headline: string; readonly firstMove: string } | undefined {
  const normalized = normalizeAgentDeviceError(cause);
  const wire = details(cause).runnerErrorCode;
  return RUNNER_STATE.get(normalized.code) ?? (typeof wire === 'string' ? RUNNER_STATE.get(wire) : undefined);
}

/** True when the iOS runner acquired a snapshot and failed its own presentation check on it. */
function isPresentationFailure(cause: unknown): boolean {
  if (normalizeAgentDeviceError(cause).code === PRESENTATION_CODE) return true;
  const reason = details(cause).reason;
  return typeof reason === 'string' && PRESENTATION_REASONS.has(reason);
}

/**
 * The message for a fault of the automation runner itself: what the runner
 * is doing, where (the session and device when the caller knows them),
 * agent-device's own text, then the recovery. The harness reports an engine
 * fault under the agent as `APP_UNREACHABLE`, so the message has to say the
 * app is not the part that failed.
 */
function runnerMessage(
  operation: string,
  where: string | undefined,
  state: { readonly headline: string; readonly firstMove: string },
  cause: unknown,
): string {
  const location = where === undefined ? '' : ` (${where})`;
  return `${operation} failed: ${state.headline}${location}: ${message(cause)} The app is fine. ${state.firstMove} ${RUNNER_RECOVERY}`;
}

/**
 * Translates an unexpected agent-device error at the contract boundary.
 * `where` names the session and device the command ran under, for the
 * messages whose recovery is per device.
 */
export function translateError(cause: unknown, operation: string, where?: string): Error {
  if (isClassified(cause)) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') return cancelled(`${operation} cancelled`);
  const normalized = normalizeAgentDeviceError(cause);
  const text = `${operation} failed: ${withHint(cause, normalized.message)}`;
  const options = { retryable: false, cause };
  if (normalized.code === 'SESSION_NOT_FOUND' || NO_SESSION_PATTERN.test(normalized.message)) {
    return new EngineError('INVALID_STATE', text, options);
  }
  if (UNSUPPORTED_CODES.has(normalized.code) || UNSUPPORTED_PATTERN.test(normalized.message)) {
    return new EngineError('UNSUPPORTED_CAPABILITY', text, options);
  }
  const state = runnerState(cause);
  if (state !== undefined) return new EngineError('ENGINE_FAILURE', runnerMessage(operation, where, state, cause), options);
  if (isPresentationFailure(cause)) {
    return new EngineError('ENGINE_FAILURE', runnerMessage(operation, where, PRESENTATION, cause), options);
  }
  return new EngineError('ENGINE_FAILURE', text, options);
}

/**
 * True for a translated failure of the iOS automation runner itself: busy,
 * wedged, or past its watchdog. The runner, not the app, is what needs
 * attention, so a caller that tolerates an app that did not open (warm-up)
 * must not tolerate this.
 */
export function isRunnerFailure(error: unknown): boolean {
  return error instanceof Error && runnerState(error.cause) !== undefined;
}

/**
 * True for a translated snapshot the iOS runner acquired but could not
 * present. The check is per capture and the capture is a read, so one retry
 * is safe and usually enough.
 */
export function isSnapshotPresentationFailure(error: unknown): boolean {
  return error instanceof Error && isPresentationFailure(error.cause);
}

/**
 * Runs one agent-device command under an abort signal and translates its
 * failure onto the engine taxonomy: the one boundary every command crosses.
 */
export async function runCommand<T>(label: string, work: () => Promise<T>, signal: AbortSignal, where?: string): Promise<T> {
  try {
    return await raceAbort(work, signal, label);
  } catch (cause) {
    throw translateError(cause, label, where);
  }
}

/**
 * Like translateError, but a ref the daemon no longer binds becomes retryable
 * `NODE_STALE`: nothing was dispatched, so the harness may re-observe and
 * re-resolve the node instead of failing the action.
 */
export function staleOr(cause: unknown, operation: string, where?: string): Error {
  if (isClassified(cause)) return cause;
  const normalized = normalizeAgentDeviceError(cause);
  if (STALE_PATTERN.test(normalized.message)) {
    return new EngineError('NODE_STALE', `${operation}: ${normalized.message}`, { retryable: true, cause });
  }
  return translateError(cause, operation, where);
}
