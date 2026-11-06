/** One deadline per engine operation, and the time it leaves the driver's own timeouts. */
import { EngineError, raceAbort } from 'e2e/engine';

/** What an operation may spend: its signal and the milliseconds left. */
export interface OperationBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** The error `signal` aborted with when it is an engine-owned deadline, else a plain cancellation of `label`. */
export function abortError(signal: AbortSignal, label: string): EngineError {
  return signal.reason instanceof EngineError && signal.reason.code === 'OPERATION_TIMEOUT'
    ? signal.reason
    : new EngineError('CANCELLED', `${label} cancelled`, { retryable: false });
}

/**
 * How much sooner than an operation's deadline the driver's own timeout
 * fires: its error names what blocked an action, or that the input was
 * already dispatched, and this lead lets that answer arrive before the
 * deadline does. The deadline is for the calls the browser never answers: an
 * evaluate, which takes no timeout, and a point tap on a page whose renderer
 * is stuck in a script. A budget shorter than twice the lead splits in half.
 */
const DRIVER_TIMEOUT_LEAD_MS = 250;

/**
 * Bounds one operation by its budget: work still pending at the deadline is
 * aborted and abandoned as `OPERATION_TIMEOUT` instead of holding the test
 * until its own timeout. `work` gets a signal that aborts at the deadline or
 * on cancellation, and the time to pass the driver's own timeouts, which
 * fire `DRIVER_TIMEOUT_LEAD_MS` sooner.
 */
export async function withDeadline<T>(operation: OperationBudget, label: string, work: (budget: OperationBudget) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  const expire = (): void => controller.abort(new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false }));
  if (operation.timeoutMs <= 0) expire();
  const timer = setTimeout(expire, Math.max(0, operation.timeoutMs));
  try {
    if (signal.aborted) throw abortError(signal, label);
    const lead = Math.min(DRIVER_TIMEOUT_LEAD_MS, operation.timeoutMs / 2);
    return await raceAbort(() => work({ signal, timeoutMs: Math.ceil(operation.timeoutMs - lead) }), signal, label);
  } catch (cause) {
    if (signal.aborted) throw abortError(operation.signal.aborted ? operation.signal : signal, label);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
