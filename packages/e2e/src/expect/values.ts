/** Synchronous plain-value matchers. */

import { equals, iterableEquality } from '@vitest/expect';
import { TestError } from '../internal/errors.ts';
import { testPattern } from '../internal/regexp.ts';
import type { ValueExpectation } from '../types.ts';

function fail(message: string): never {
  throw new TestError('ASSERTION_FAILED', message);
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  try {
    const json = JSON.stringify(value);
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

  get not(): ValueExpectation<T> {
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

  toContain(expected: unknown): void {
    let contains: boolean;
    const actual = this.actual as unknown;
    if (typeof actual === 'string') {
      if (typeof expected !== 'string') {
        fail(`toContain on a string requires a string, got ${format(expected)}`);
      }
      contains = actual.includes(expected);
    } else if (typeof actual === 'object' && actual !== null && Symbol.iterator in actual) {
      contains = [...(actual as Iterable<unknown>)].some((item) =>
        equals(item, expected, [iterableEquality]),
      );
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
    const matches =
      typeof expected === 'string'
        ? actual.includes(expected)
        : testPattern(expected.source, expected.flags, actual);
    this.check(
      matches,
      () => `expected ${format(actual)} to match ${format(expected)}`,
      () => `expected ${format(actual)} not to match ${format(expected)}`,
    );
  }

  toBeGreaterThan(expected: number): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeGreaterThan requires a number, got ${format(actual)}`);
    this.check(
      actual > expected,
      () => `expected ${actual} to be greater than ${expected}`,
      () => `expected ${actual} not to be greater than ${expected}`,
    );
  }

  toBeLessThan(expected: number): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeLessThan requires a number, got ${format(actual)}`);
    this.check(
      actual < expected,
      () => `expected ${actual} to be less than ${expected}`,
      () => `expected ${actual} not to be less than ${expected}`,
    );
  }

  toBeGreaterThanOrEqual(expected: number): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeGreaterThanOrEqual requires a number, got ${format(actual)}`);
    this.check(
      actual >= expected,
      () => `expected ${actual} to be greater than or equal to ${expected}`,
      () => `expected ${actual} not to be greater than or equal to ${expected}`,
    );
  }

  toBeLessThanOrEqual(expected: number): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeLessThanOrEqual requires a number, got ${format(actual)}`);
    this.check(
      actual <= expected,
      () => `expected ${actual} to be less than or equal to ${expected}`,
      () => `expected ${actual} not to be less than or equal to ${expected}`,
    );
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
}

export function createValueExpectation<T>(actual: T, message?: string): ValueExpectation<T> {
  return new ValueExpectationImpl(actual, false, message);
}
