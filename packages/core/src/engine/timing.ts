/** Cancellation with the engine error taxonomy and shared lifecycle mechanics. */
import { withAbort } from '../internal/time.ts';
import { EngineError } from './contract.ts';

/** Checks cancellation before dispatching a thunk, then abandons the wait on abort. */
export function raceAbort<T>(work: Promise<T> | (() => Promise<T>), signal: AbortSignal, label: string): Promise<T> {
  return withAbort(work, signal, () => new EngineError('CANCELLED', `${label} cancelled`, { retryable: false }));
}
