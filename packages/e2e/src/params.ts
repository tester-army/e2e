/**
 * The run-unique value marker for `agent.act` params. A timestamped company
 * name or a fresh email is different on every run so the record it creates
 * never collides with the last run's; recorded verbatim, it would also defeat
 * the trace cache on every run. `unique()` names such a value: the model sees
 * the string as given, and the cache keys and records a slot in its place
 * (`cache/template.ts`).
 */

import { uniqueBrand } from './internal/brands.ts';
import { TestError } from './internal/errors.ts';

/** A string param that differs on every run; the model sees `value`, the trace cache a slot. */
export interface Unique {
  readonly value: string;
  readonly [uniqueBrand]: true;
}

/**
 * Marks a value that is different on every run. Mark values the flow types
 * or looks for, not choices that steer it: two runs whose `unique()` values
 * differ replay the same recording.
 */
export function unique(value: string): Unique {
  if (typeof value !== 'string' || value === '') {
    throw new TestError('INVALID_ARGUMENT', 'unique() takes a non-empty string');
  }
  return Object.freeze({ value, [uniqueBrand]: true as const });
}

export function isUnique(value: unknown): value is Unique {
  return typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[uniqueBrand] === true;
}
