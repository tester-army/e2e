/** Object helpers shared by the runner and, through `@e2edev/e2e/backend`, by backends. */

/** Keys that may be `undefined` become optional with `undefined` removed from their type. */
export type WithoutUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Shallow copy of `value` with every `undefined`-valued key removed, typed so
 * the result satisfies `exactOptionalPropertyTypes`: an optional property is
 * absent, never present as `undefined`. Replaces the conditional-spread idiom
 * (`...(x === undefined ? {} : { x })`) with one readable literal.
 *
 * @example obj({ a: 1, b: undefined, c: 3 }) // { a: 1, c: 3 }
 */
export function obj<T extends object>(value: T): WithoutUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as WithoutUndefined<T>;
}
