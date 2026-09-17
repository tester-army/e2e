/** Scalar validators shared by the config resolvers; one message per rule. */

import { ConfigurationError } from '../internal/errors.ts';

/**
 * A positive safe integer, or undefined when the value is absent. Durations
 * name their unit, because `'30s'` and `30` are the two ways this key is
 * usually written wrong.
 */
export function positiveInt(
  value: number | undefined,
  label: string,
  unit?: 'milliseconds',
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    const expected = unit === undefined ? 'a positive safe integer' : `a positive safe integer of ${unit}`;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be ${expected}, got ${describeValue(value)}`,
    );
  }
  return value;
}

/** A value as the author wrote it, for messages that quote the offending input. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** A safe integer within [min, max], or undefined when the value is absent. */
export function boundedInt(
  value: number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an integer from ${min} through ${max}`,
    );
  }
  return value;
}

/** An absolute http(s) URL, or undefined when the value is absent. */
export function httpUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be an http(s) URL`);
  }
  return value;
}
