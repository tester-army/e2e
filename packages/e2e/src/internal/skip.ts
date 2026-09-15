/**
 * The signal a running test body raises to skip itself.
 *
 * Not an `E2EError`: a skip is a verdict, not a failure, and it must never be
 * classified, retried, or reported as one. The attempt runner recognizes the
 * signal and settles the attempt as `skipped` with the reason.
 *
 * Recognized by brand, not by class: a test module loads in its own realm and
 * may resolve `e2e` to another copy of this package (the built `dist` next to
 * a runner on `src`, or a nested install), so `instanceof` would miss a skip
 * thrown from there and report it as a failure.
 */

const runtimeSkipBrand: unique symbol = Symbol.for('e2e.runtimeSkip.v1');

export class RuntimeSkip {
  readonly [runtimeSkipBrand] = true as const;
  readonly reason: string;

  constructor(reason: string | undefined) {
    this.reason = reason === undefined || reason.trim() === '' ? 'skipped' : reason;
  }
}

export function isRuntimeSkip(value: unknown): value is RuntimeSkip {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [runtimeSkipBrand]?: unknown })[runtimeSkipBrand] === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}
