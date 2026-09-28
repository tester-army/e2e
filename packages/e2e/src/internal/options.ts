/**
 * Option-bag hygiene shared by the fixtures. The type checker catches a key a
 * call does not take in a typed test; a JavaScript test, or one written
 * against an earlier release, reaches the runtime instead and must fail there
 * too, naming the rename when there is one, rather than run on the default.
 */

import { TestError } from './errors.ts';

/**
 * Whether `value` is a plain object: not null, an array, or a class instance.
 * Its prototype is `Object.prototype` or null, so every key a later property
 * read sees is an own key a validator can enumerate.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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
