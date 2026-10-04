/**
 * Option-bag hygiene shared by the fixtures. The type checker catches a key a
 * call does not take in a typed test; a JavaScript test, or one written
 * against an earlier release, reaches the runtime instead and must fail there
 * too, naming the rename when there is one, rather than run on the default.
 */

import { ConfigurationError, TestError } from './errors.ts';
import { isPlainObject } from './objects.ts';
import { didYouMean } from './suggest.ts';

/** Rejects an options bag carrying a key `api` does not take. */
export function rejectUnknownOptions(
  api: string,
  options: object | undefined,
  known: readonly string[],
  code: 'INVALID_ARGUMENT' | 'INVALID_LOCATOR' = 'INVALID_ARGUMENT',
): void {
  if (options === undefined) return;
  if (!isPlainObject(options)) {
    throw new TestError(code, `${api} options must be a plain object`);
  }
  const unknown = Object.getOwnPropertyNames(options).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  const described = unknown.map((key) => {
    // Durations dropped their Ms suffix in 0.8: intervalMs is interval.
    const renamed = key.endsWith('Ms') ? key.slice(0, -'Ms'.length) : undefined;
    return renamed !== undefined && known.includes(renamed)
      ? `"${key}" (now "${renamed}")`
      : `"${key}"`;
  });
  throw new TestError(
    code,
    `${api} options has no ${unknown.length === 1 ? 'key' : 'keys'} ${described.join(', ')}; it takes ${known.join(', ')}`,
  );
}

/**
 * The message for the first own key of `value` outside `keys`, enumerable
 * or not, as `rejectUnknownOptions` reads them: the nearest
 * known key when one is a plausible typo, every known key otherwise.
 * Undefined when every key is known.
 */
export function unknownKeyMessage(label: string, value: object, keys: readonly string[]): string | undefined {
  const key = Object.getOwnPropertyNames(value).find((candidate) => !keys.includes(candidate));
  if (key === undefined) return undefined;
  const hint = didYouMean(key, keys);
  return `${label} has unknown key "${key}"${hint === '' ? `; expected one of ${keys.join(', ')}` : hint}`;
}

/**
 * Refuses an object carrying a key outside `keys`, naming the nearest known
 * key, so a misspelled option fails instead of falling through to a default:
 * `INVALID_CONFIG` for a config object, the default, or `INVALID_ARGUMENT`
 * for an argument a test passes.
 */
export function rejectUnknownKeys(
  label: string,
  value: object,
  keys: readonly string[],
  code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT' = 'INVALID_CONFIG',
): void {
  const message = unknownKeyMessage(label, value, keys);
  if (message === undefined) return;
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
