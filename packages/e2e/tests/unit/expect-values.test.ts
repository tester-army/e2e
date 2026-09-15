import { describe, expect as vexpect, it } from 'vitest';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import { TestError } from '../../src/internal/errors.ts';

function failsWith(fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    vexpect(error).toBeInstanceOf(TestError);
    vexpect((error as TestError).code).toBe('ASSERTION_FAILED');
    vexpect((error as TestError).message).toMatch(pattern);
    return;
  }
  throw new Error('expected assertion to fail');
}

describe('value matchers', () => {
  it('toBe uses Object.is', () => {
    e2eExpect(1).toBe(1);
    e2eExpect(Number.NaN).toBe(Number.NaN);
    failsWith(() => e2eExpect<unknown>({}).toBe({}), /to be/);
    failsWith(() => e2eExpect(0).toBe(-0 as never), /to be/);
  });

  it('toEqual performs recursive structural equality', () => {
    e2eExpect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    e2eExpect(new Map([['k', 1]])).toEqual(new Map([['k', 1]]));
    failsWith(() => e2eExpect({ a: 1 }).toEqual({ a: 2 }), /to equal/);
  });

  it('truthy/falsy/null/undefined/defined', () => {
    e2eExpect(1).toBeTruthy();
    e2eExpect('').toBeFalsy();
    e2eExpect(null).toBeNull();
    e2eExpect(undefined).toBeUndefined();
    e2eExpect('x').toBeDefined();
    failsWith(() => e2eExpect(null).toBeDefined(), /defined/);
  });

  it('toContain works on strings, arrays, sets, and iterables', () => {
    e2eExpect('hello world').toContain('world');
    e2eExpect([1, 2, 3]).toContain(2);
    e2eExpect([{ a: 1 }]).toContain({ a: 1 });
    e2eExpect(new Set(['x'])).toContain('x');
    failsWith(() => e2eExpect([1]).toContain(9), /to contain/);
    failsWith(() => e2eExpect(42 as unknown as string).toContain(1), /string or collection/);
  });

  it('toMatch accepts substrings and regexps', () => {
    e2eExpect('order #42').toMatch('#42');
    e2eExpect('order #42').toMatch(/#\d+/);
    failsWith(() => e2eExpect('abc').toMatch(/xyz/), /to match/);
  });

  it('toMatch gives the same answer on every test of a global or sticky regexp', () => {
    const global = /done/g;
    e2eExpect('done').toMatch(global);
    e2eExpect('done').toMatch(global);
    failsWith(() => e2eExpect('done').not.toMatch(global), /not to match/);
    failsWith(() => e2eExpect('done').not.toMatch(global), /not to match/);
    const sticky = /done/y;
    e2eExpect('done').toMatch(sticky);
    e2eExpect('done').toMatch(sticky);
  });

  it('numeric comparisons', () => {
    e2eExpect(5).toBeGreaterThan(4);
    e2eExpect(3).toBeLessThan(4);
    failsWith(() => e2eExpect(1).toBeGreaterThan(2), /greater/);
    failsWith(() => e2eExpect('x' as unknown as number).toBeGreaterThan(2), /requires a number/);
  });

  it('inclusive comparisons accept the bound itself', () => {
    e2eExpect(4).toBeGreaterThanOrEqual(4);
    e2eExpect(5).toBeGreaterThanOrEqual(4);
    e2eExpect(4).toBeLessThanOrEqual(4);
    e2eExpect(3).toBeLessThanOrEqual(4);
    failsWith(() => e2eExpect(3).toBeGreaterThanOrEqual(4), /greater than or equal/);
    failsWith(() => e2eExpect(5).toBeLessThanOrEqual(4), /less than or equal/);
    failsWith(() => e2eExpect(4).not.toBeLessThanOrEqual(4), /not to be less than or equal/);
  });

  it('toBeCloseTo follows the half-unit rule of the last kept digit', () => {
    e2eExpect(59.996).toBeCloseTo(60);
    e2eExpect(0.1 + 0.2).toBeCloseTo(0.3);
    e2eExpect(60).toBeCloseTo(60, 10);
    e2eExpect(Number.POSITIVE_INFINITY).toBeCloseTo(Number.POSITIVE_INFINITY);
    e2eExpect(59.9).toBeCloseTo(60, 0);
    failsWith(() => e2eExpect(59.99).toBeCloseTo(60), /close to 60 \(2 digits\)/);
    failsWith(() => e2eExpect(59.4).toBeCloseTo(60, 0), /close to/);
    failsWith(() => e2eExpect(60).not.toBeCloseTo(60), /not to be close/);
    failsWith(() => e2eExpect(60).toBeCloseTo(60, -1), /non-negative integer/);
    failsWith(() => e2eExpect('60' as unknown as number).toBeCloseTo(60), /requires a number/);
  });

  it('a message opens the failure text, and survives negation', () => {
    e2eExpect(true, 'the user exists through the API').toBe(true);
    failsWith(() => e2eExpect(false, 'the user exists through the API').toBe(true), /^the user exists through the API: expected false to be true$/);
    failsWith(() => e2eExpect(1, 'count').not.toBe(1), /^count: expected 1 not to be 1$/);
  });

  it('negation via .not', () => {
    e2eExpect(1).not.toBe(2);
    e2eExpect({ a: 1 }).not.toEqual({ a: 2 });
    e2eExpect('abc').not.toContain('z');
    failsWith(() => e2eExpect(1).not.toBe(1), /not to be/);
  });

  it('double negation returns to positive', () => {
    e2eExpect(1).not.not.toBe(1);
  });
});
