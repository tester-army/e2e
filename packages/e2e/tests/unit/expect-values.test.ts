import { describe, expect as vexpect, it } from 'vitest';
import { expect as e2eExpect } from '../../src/expect/index.js';
import { TestError } from '../../src/internal/errors.js';

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

  it('numeric comparisons', () => {
    e2eExpect(5).toBeGreaterThan(4);
    e2eExpect(3).toBeLessThan(4);
    failsWith(() => e2eExpect(1).toBeGreaterThan(2), /greater/);
    failsWith(() => e2eExpect('x' as unknown as number).toBeGreaterThan(2), /requires a number/);
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
