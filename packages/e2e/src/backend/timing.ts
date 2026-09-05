/** Cancellation with the backend error taxonomy and shared lifecycle mechanics. */
import { withAbort } from '../internal/time.ts';
import { BackendError } from './contract.ts';

/** Checks cancellation before dispatching a thunk, then abandons the wait on abort. */
export function raceAbort<T>(work: Promise<T> | (() => Promise<T>), signal: AbortSignal, label: string): Promise<T> {
  return withAbort(work, signal, () => new BackendError('CANCELLED', `${label} cancelled`, { retryable: false }));
}
