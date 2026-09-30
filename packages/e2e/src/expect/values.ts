/** Synchronous plain-value matchers. */

import { types } from 'node:util';
import { equals, isAsymmetric, iterableEquality, subsetEquality } from '@vitest/expect';
import { TestError } from '../internal/errors.ts';
import { testPattern } from '../internal/regexp.ts';
import { describeIssue, requireStandardSchema } from '../internal/standard-schema.ts';
import { toTextPattern } from '../internal/text.ts';
import type { AsymmetricMatcher, NegatedValueExpectation, PropertyPath, StandardSchemaV1, ValueExpectation } from '../types.ts';

function fail(message: string): never {
  throw new TestError('ASSERTION_FAILED', message);
}

/**
 * An asymmetric matcher as it reads in a failure: `Any<Number>` and
 * `Anything` describe themselves; the rest print their name and sample,
 * `ObjectContaining {"id":1}`.
 */
function describeMatcher(matcher: AsymmetricMatcher): string {
  const own = (matcher as { toAsymmetricMatcher?: () => string }).toAsymmetricMatcher?.();
  if (own !== undefined) return own;
  const sample = (matcher as { sample?: unknown }).sample;
  return `${matcher.toString()} ${format(sample)}`;
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (isAsymmetric(value)) return describeMatcher(value);
  if (value instanceof RegExp) return String(value);
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => (isAsymmetric(nested) ? describeMatcher(nested) : nested));
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return String(value);
}

class ValueExpectationImpl<T> implements ValueExpectation<T> {
  constructor(
    private readonly actual: T,
    private readonly negated: boolean,
    /** The caller's label for this check, opening every failure message. */
    private readonly message: string | undefined,
  ) {}

  get not(): NegatedValueExpectation<T> {
    return new ValueExpectationImpl(this.actual, !this.negated, this.message);
  }

  /** Messages are thunks: formatting large values is paid only on failure. */
  private check(condition: boolean, positive: () => string, negative: () => string): void {
    if (this.negated) {
      if (condition) this.fail(negative());
      return;
    }
    if (!condition) this.fail(positive());
  }

  private fail(detail: string): never {
    fail(this.message === undefined ? detail : `${this.message}: ${detail}`);
  }

  toBe(expected: T): void {
    this.check(
      Object.is(this.actual, expected),
      () => `expected ${format(this.actual)} to be ${format(expected)}`,
      () => `expected ${format(this.actual)} not to be ${format(expected)}`,
    );
  }

  toEqual(expected: unknown): void {
    this.check(
      equals(this.actual, expected, [iterableEquality]),
      () => `expected ${format(this.actual)} to equal ${format(expected)}`,
      () => `expected ${format(this.actual)} not to equal ${format(expected)}`,
    );
  }

  toMatchObject(expected: object): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'object' || actual === null) {
      fail(`toMatchObject requires an object, got ${format(actual)}`);
    }
    if (typeof expected !== 'object' || expected === null) {
      fail(`toMatchObject takes an object to match against, got ${format(expected)}`);
    }
    this.check(
      equals(actual, expected, [iterableEquality, subsetEquality]),
      () => `expected ${format(actual)} to match object ${format(expected)}`,
      () => `expected ${format(actual)} not to match object ${format(expected)}`,
    );
  }

  toBeTruthy(): void {
    this.check(
      Boolean(this.actual),
      () => `expected ${format(this.actual)} to be truthy`,
      () => `expected ${format(this.actual)} not to be truthy`,
    );
  }

  toBeFalsy(): void {
    this.check(
      !this.actual,
      () => `expected ${format(this.actual)} to be falsy`,
      () => `expected ${format(this.actual)} not to be falsy`,
    );
  }

  toBeNull(): void {
    this.check(
      this.actual === null,
      () => `expected ${format(this.actual)} to be null`,
      () => `expected value not to be null`,
    );
  }

  toBeUndefined(): void {
    this.check(
      this.actual === undefined,
      () => `expected ${format(this.actual)} to be undefined`,
      () => `expected value not to be undefined`,
    );
  }

  toBeDefined(): void {
    this.check(
      this.actual !== undefined && this.actual !== null,
      () => `expected ${format(this.actual)} to be defined`,
      () => `expected ${format(this.actual)} not to be defined`,
    );
  }

  toHaveLength(expected: number): void {
    const actual = this.actual as unknown;
    const length = (actual as { length?: unknown } | null | undefined)?.length;
    if ((typeof actual !== 'object' && typeof actual !== 'string' && typeof actual !== 'function') || typeof length !== 'number') {
      fail(`toHaveLength requires a value with a numeric length, got ${format(actual)}`);
    }
    this.check(
      length === expected,
      () => `expected ${format(actual)} to have length ${expected}, got ${length}`,
      () => `expected ${format(actual)} not to have length ${expected}`,
    );
  }

  toHaveProperty(path: PropertyPath, ...expected: [] | [expected: unknown]): void {
    const keys = typeof path === 'string' ? path.split('.') : [...path];
    if (keys.length === 0 || keys.some((key) => key === '')) {
      fail(`toHaveProperty takes a dotted path or an array of keys, got ${format(path)}`);
    }
    const label = keys.map(String).join('.');
    const found = lookup(this.actual, keys);
    if (expected.length === 0) {
      this.check(
        found.present,
        () => `expected ${format(this.actual)} to have property "${label}"`,
        () => `expected ${format(this.actual)} not to have property "${label}"`,
      );
      return;
    }
    const [value] = expected;
    this.check(
      found.present && equals(found.value, value, [iterableEquality]),
      () =>
        found.present
          ? `expected property "${label}" of ${format(this.actual)} to equal ${format(value)}, got ${format(found.value)}`
          : `expected ${format(this.actual)} to have property "${label}" equal to ${format(value)}`,
      () => `expected property "${label}" of ${format(this.actual)} not to equal ${format(value)}`,
    );
  }

  toContain(expected: unknown): void {
    let contains: boolean;
    const actual = this.actual as unknown;
    if (typeof actual === 'string') {
      if (typeof expected !== 'string') {
        fail(`toContain on a string requires a string, got ${format(expected)}`);
      }
      contains = actual.includes(expected);
    } else if (typeof actual === 'object' && actual !== null && Symbol.iterator in actual) {
      contains = [...(actual as Iterable<unknown>)].some((item) => equals(item, expected, [iterableEquality]));
    } else {
      fail(`toContain requires a string or collection, got ${format(actual)}`);
    }
    this.check(
      contains,
      () => `expected ${format(this.actual)} to contain ${format(expected)}`,
      () => `expected ${format(this.actual)} not to contain ${format(expected)}`,
    );
  }

  toMatch(expected: string | RegExp): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'string') {
      fail(`toMatch requires a string, got ${format(actual)}`);
    }
    // A global or sticky RegExp keeps `lastIndex` between tests; a matcher
    // that is polled must see the same answer for the same value every time.
    const pattern = toTextPattern(expected);
    const matches =
      pattern.kind === 'string'
        ? actual.includes(pattern.value)
        : testPattern(pattern.source, pattern.flags, actual);
    this.check(
      matches,
      () => `expected ${format(actual)} to match ${format(expected)}`,
      () => `expected ${format(actual)} not to match ${format(expected)}`,
    );
  }

  toBeGreaterThan(expected: number): void {
    this.compareNumber('toBeGreaterThan', expected, (actual) => actual > expected, 'greater than');
  }

  toBeGreaterThanOrEqual(expected: number): void {
    this.compareNumber('toBeGreaterThanOrEqual', expected, (actual) => actual >= expected, 'greater than or equal to');
  }

  toBeLessThan(expected: number): void {
    this.compareNumber('toBeLessThan', expected, (actual) => actual < expected, 'less than');
  }

  toBeLessThanOrEqual(expected: number): void {
    this.compareNumber('toBeLessThanOrEqual', expected, (actual) => actual <= expected, 'less than or equal to');
  }

  /**
   * Jest's rule: the difference must be under half a unit of the last kept
   * digit, so `toBeCloseTo(60)` accepts 59.996 and rejects 59.99. Infinite
   * values pass only when they are the same infinity.
   */
  toBeCloseTo(expected: number, digits = 2): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeCloseTo requires a number, got ${format(actual)}`);
    if (!Number.isInteger(digits) || digits < 0) {
      fail(`toBeCloseTo digits must be a non-negative integer, got ${format(digits)}`);
    }
    const close =
      actual === expected ||
      (Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 10 ** -digits / 2);
    this.check(
      close,
      () => `expected ${actual} to be close to ${expected} (${digits} digits)`,
      () => `expected ${actual} not to be close to ${expected} (${digits} digits)`,
    );
  }

  /**
   * Validates synchronously: a matcher returns before anything could await
   * it. The output is the schema's (defaults applied, transforms run); a
   * negated check returns nothing, as its type says.
   */
  toMatchSchema<Schema extends StandardSchemaV1>(schema: Schema): StandardSchemaV1.InferOutput<Schema> {
    requireStandardSchema(schema, 'toMatchSchema schema');
    const result = schema['~standard'].validate(this.actual);
    if (types.isPromise(result)) {
      result.catch(() => undefined);
      throw new TestError(
        'INVALID_ARGUMENT',
        'toMatchSchema takes a synchronous schema, and this one validates asynchronously (an async refinement or transform); await schema["~standard"].validate(value) yourself instead',
      );
    }
    const { issues } = result;
    this.check(
      issues === undefined,
      () => `expected ${format(this.actual)} to match the schema:\n${(issues ?? []).map((issue) => `- ${describeIssue(issue)}`).join('\n')}`,
      () => `expected ${format(this.actual)} not to match the schema`,
    );
    return (this.negated || result.issues !== undefined ? undefined : result.value) as StandardSchemaV1.InferOutput<Schema>;
  }

  /** The one body of the four ordering matchers: a number on the left, a phrase for the message. */
  private compareNumber(name: string, expected: number, holds: (actual: number) => boolean, phrase: string): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`${name} requires a number, got ${format(actual)}`);
    this.check(
      holds(actual),
      () => `expected ${actual} to be ${phrase} ${expected}`,
      () => `expected ${actual} not to be ${phrase} ${expected}`,
    );
  }
}

/** Walks `keys` into `value`; `present` says whether the whole path resolved. */
function lookup(value: unknown, keys: readonly (string | number)[]): { present: boolean; value: unknown } {
  let current: unknown = value;
  for (const key of keys) {
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null || !(key in current)) {
      return { present: false, value: undefined };
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return { present: true, value: current };
}

export function createValueExpectation<T>(actual: T, message?: string): ValueExpectation<T> {
  return new ValueExpectationImpl(actual, false, message);
}
