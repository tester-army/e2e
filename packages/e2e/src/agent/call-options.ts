/**
 * Per-call option resolution shared by every agent method. One owner for the
 * budget policy: a per-call override can only tighten a configured limit,
 * never escape it.
 */

import { TestError } from '../internal/errors.ts';

/** Resolves a per-call timeout against the configured fallback. */
export function resolveTimeout(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', 'timeout must be a positive integer');
  }
  return requested;
}

/** Resolves a per-call budget override, capped at the configured limit. */
export function resolveBoundedBudget(
  requested: number | undefined,
  limit: number,
  label: string,
): number {
  if (requested === undefined) return limit;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  if (requested > limit) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${label} ${requested} exceeds the resolved limit ${limit}`,
    );
  }
  return requested;
}
