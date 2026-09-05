/** Scalar validators shared by the config resolvers; one message per rule. */

import { ConfigurationError } from '../internal/errors.ts';

/** A positive safe integer, or undefined when the value is absent. */
export function positiveInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a positive safe integer`);
  }
  return value;
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
