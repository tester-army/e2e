/**
 * Option-bag hygiene shared by the fixtures. The type checker catches a key a
 * call does not take in a typed test; a JavaScript test, or one written
 * against an earlier release, reaches the runtime instead and must fail there
 * too, naming the rename when there is one, rather than run on the default.
 */

import { TestError } from './errors.ts';

/** Rejects an options bag carrying a key `api` does not take. */
export function rejectUnknownOptions(
  api: string,
  options: object | undefined,
  known: readonly string[],
): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TestError('INVALID_ARGUMENT', `${api} options must be a plain object`);
  }
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  const described = unknown.map((key) => {
    // Durations dropped their Ms suffix in 0.8: intervalMs is interval.
    const renamed = key.endsWith('Ms') ? key.slice(0, -'Ms'.length) : undefined;
    return renamed !== undefined && known.includes(renamed)
      ? `"${key}" (now "${renamed}")`
      : `"${key}"`;
  });
  throw new TestError(
    'INVALID_ARGUMENT',
    `${api} options has no ${unknown.length === 1 ? 'key' : 'keys'} ${described.join(', ')}; it takes ${known.join(', ')}`,
  );
}
