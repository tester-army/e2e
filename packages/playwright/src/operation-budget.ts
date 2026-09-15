/** One deadline for connection recovery and the operation it precedes. */
import { EngineError, raceAbort } from 'e2e/engine';

export interface ConnectionBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Preserves the reason for an engine-owned deadline without relabeling caller cancellation. */
export function connectionAbort(signal: AbortSignal, label: string): EngineError {
  return signal.reason instanceof EngineError && signal.reason.code === 'OPERATION_TIMEOUT'
    ? signal.reason
    : new EngineError('CANCELLED', `${label} cancelled`, { retryable: false });
}

/** Bounds the entire transition, aborts abandoned work, and never grants a fresh dispatch budget. */
export async function withConnectionBudget<T>(
  budget: ConnectionBudget,
  label: string,
  work: (remaining: () => ConnectionBudget) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([budget.signal, controller.signal]);
  const endsAt = Date.now() + budget.timeoutMs;
  const timeout = () => new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false });
  const timer = setTimeout(() => controller.abort(timeout()), Math.max(0, budget.timeoutMs));
  const remaining = (): ConnectionBudget => {
    if (signal.aborted) throw connectionAbort(signal, label);
    const timeoutMs = endsAt - Date.now();
    if (timeoutMs <= 0) {
      controller.abort(timeout());
      throw connectionAbort(signal, label);
    }
    return { signal, timeoutMs };
  };
  try {
    return await raceAbort(() => work(remaining), signal, label);
  } catch (cause) {
    if (budget.signal.aborted) throw connectionAbort(budget.signal, label);
    if (signal.aborted) throw connectionAbort(signal, label);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
