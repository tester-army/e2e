import { describe, expect as vexpect, it } from 'vitest';
import { z } from 'zod';
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
    e2eExpect(null).toBeDefined();
    failsWith(() => e2eExpect(undefined).toBeDefined(), /to be defined/);
    failsWith(() => e2eExpect(null).not.toBeDefined(), /not to be defined/);
  });

  it('truthy/falsy/null/undefined fail on the wrong value, and pass negated', () => {
    failsWith(() => e2eExpect(undefined).toBeTruthy(), /^expected undefined to be truthy/);
    failsWith(() => e2eExpect(0).toBeTruthy(), /^expected 0 to be truthy/);
    failsWith(() => e2eExpect(1).not.toBeTruthy(), /^expected 1 not to be truthy/);
    failsWith(() => e2eExpect(1).toBeFalsy(), /^expected 1 to be falsy/);
    failsWith(() => e2eExpect('').not.toBeFalsy(), /^expected "" not to be falsy/);
    failsWith(() => e2eExpect(0).toBeNull(), /^expected 0 to be null/);
    failsWith(() => e2eExpect(undefined).toBeNull(), /^expected undefined to be null/);
    failsWith(() => e2eExpect(null).not.toBeNull(), /^expected value not to be null/);
    failsWith(() => e2eExpect(null).toBeUndefined(), /^expected null to be undefined/);
    failsWith(() => e2eExpect(undefined).not.toBeUndefined(), /^expected value not to be undefined/);
    e2eExpect(0).not.toBeTruthy();
    e2eExpect(1).not.toBeFalsy();
    e2eExpect(undefined).not.toBeNull();
    e2eExpect(null).not.toBeUndefined();
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

  it('toMatch rejects a predicate instead of matching everything', () => {
    const predicate = ((text: string) => text === 'xyz') as unknown as RegExp;
    vexpect(() => e2eExpect('abc').toMatch(predicate)).toThrow(vexpect.objectContaining({ code: 'INVALID_ARGUMENT' }));
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

  it('toEqual ignores undefined properties and class types', () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    const sparse: (number | undefined)[] = [1];
    sparse[2] = 3;
    e2eExpect({ a: 1, b: undefined }).toEqual({ a: 1 });
    e2eExpect(new Point(1, 2)).toEqual({ x: 1, y: 2 });
    e2eExpect(sparse).toEqual([1, undefined, 3]);
  });

  it('toEqual compares dates, regexps, errors, sets, maps, and cycles', () => {
    e2eExpect(new Date(1)).toEqual(new Date(1));
    failsWith(() => e2eExpect(new Date(1)).toEqual(new Date(2)), /to equal/);
    e2eExpect(/a/i).toEqual(/a/i);
    failsWith(() => e2eExpect(/a/i).toEqual(/a/g), /to equal/);
    e2eExpect(new TypeError('boom')).toEqual(new TypeError('boom'));
    failsWith(() => e2eExpect(new TypeError('boom')).toEqual(new Error('boom')), /to equal/);
    e2eExpect(new Set([{ a: 1 }])).toEqual(new Set([{ a: 1 }]));
    e2eExpect(new Map([[{ k: 1 }, 'v']])).toEqual(new Map([[{ k: 1 }, 'v']]));
    failsWith(() => e2eExpect(new Map([['k', 1]])).toEqual(new Map([['k', 2]])), /to equal/);
    failsWith(() => e2eExpect(0).toEqual(-0), /to equal/);
    const left: { self?: unknown } = {};
    left.self = left;
    const right: { self?: unknown } = {};
    right.self = right;
    e2eExpect(left).toEqual(right);
  });

  it('matches Set and Map entries by structure, in any order, with Jest\'s rules', () => {
    e2eExpect(new Set([{ x: 1 }, { y: 2 }])).toEqual(new Set([{ y: 2 }, { x: 1 }]));
    e2eExpect(new Map([[{ k: 1 }, 'a'], [{ k: 2 }, 'b']])).toEqual(new Map([[{ k: 2 }, 'b'], [{ k: 1 }, 'a']]));
    failsWith(() => e2eExpect(new Map([[{ k: 1 }, 'a']])).toEqual(new Map([[{ k: 1 }, 'b']])), /to equal/);
    failsWith(
      () => e2eExpect(new Map([[{ k: 1 }, 'a'], [{ k: 1 }, 'b']])).toEqual(new Map([[{ k: 1 }, 'a'], [{ k: 2 }, 'b']])),
      /to equal/,
    );
    // Jest's Set rule: every actual entry needs some structurally equal expected
    // entry of the same size, and one expected entry may serve several. Two
    // distinct `{ x: 1 }` are therefore satisfied by a single `{ x: 1 }`.
    e2eExpect(new Set([{ x: 1 }, { x: 1 }])).toEqual(new Set([{ x: 1 }, { y: 2 }]));
    failsWith(() => e2eExpect(new Set([{ x: 1 }, { x: 1 }])).toEqual(new Set([{ y: 2 }, { z: 3 }])), /to equal/);
  });

  it('fails, rather than throwing, when only one side is iterable', () => {
    failsWith(() => e2eExpect(new Set([1])).toEqual({}), /to equal/);
    const iterable = {
      *[Symbol.iterator]() {
        yield 1;
      },
    };
    failsWith(() => e2eExpect<unknown>(iterable).toEqual({}), /to equal/);
    failsWith(() => e2eExpect<unknown>({}).toEqual(iterable), /to equal/);
  });

  it('compares a non-index key on an array, so "01" is a property and not a hole', () => {
    failsWith(() => e2eExpect(Object.assign([1, 2], { '01': 'a' })).toEqual(Object.assign([1, 2], { '01': 'b' })), /to equal/);
    failsWith(() => e2eExpect(Object.assign([1], { '4294967295': 'a' })).toEqual([1]), /to equal/);
    e2eExpect(Object.assign([1], { extra: 'x' })).toEqual(Object.assign([1], { extra: 'x' }));
    e2eExpect([1, 2]).toEqual([1, 2]);
  });

  it('toMatchObject terminates on a self-referencing expected object or array', () => {
    const actual: { a: number; self?: unknown } = { a: 1 };
    actual.self = actual;
    const same: { a: number; self?: unknown } = { a: 1 };
    same.self = same;
    e2eExpect(actual).toMatchObject(same);
    const list: unknown[] = [];
    list.push(list);
    const expectedList: unknown[] = [];
    expectedList.push(expectedList);
    e2eExpect(list).toMatchObject(expectedList);
    // Jest's rule at a cycle: the subset walk stops and the pair is compared
    // for full equality, so an actual with a property the expected lacks no
    // longer matches once the reference comes round again.
    const expected: { self?: unknown } = {};
    expected.self = expected;
    failsWith(() => e2eExpect(actual).toMatchObject(expected), /to match object/);
    const other: { self?: unknown; b?: number } = { b: 2 };
    other.self = other;
    failsWith(() => e2eExpect(actual).toMatchObject({ self: other }), /to match object/);
  });

  it('toMatchObject matches a subset recursively, arrays element-wise', () => {
    const order = { id: 7, customer: { name: 'Ada', email: 'ada@example.test' }, lines: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }] };
    e2eExpect(order).toMatchObject({ id: 7 });
    e2eExpect(order).toMatchObject({ customer: { name: 'Ada' } });
    e2eExpect(order).toMatchObject({ lines: [{ sku: 'a' }, { sku: 'b' }] });
    e2eExpect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]);
    failsWith(() => e2eExpect(order).toMatchObject({ lines: [{ sku: 'a' }] }), /to match object/);
    failsWith(() => e2eExpect(order).toMatchObject({ customer: { name: 'Bob' } }), /to match object/);
    failsWith(() => e2eExpect(order).toMatchObject({ missing: 1 }), /to match object/);
    failsWith(() => e2eExpect(order).not.toMatchObject({ id: 7 }), /not to match object/);
    e2eExpect(order).not.toMatchObject({ id: 8 });
    failsWith(() => e2eExpect(7 as unknown as object).toMatchObject({}), /requires an object/);
    failsWith(() => e2eExpect({}).toMatchObject(null as unknown as object), /takes an object/);
  });

  it('toHaveLength reads a length', () => {
    e2eExpect('abc').toHaveLength(3);
    e2eExpect([1, 2]).toHaveLength(2);
    e2eExpect({ length: 4 }).toHaveLength(4);
    e2eExpect([1]).not.toHaveLength(2);
    failsWith(() => e2eExpect([1, 2]).toHaveLength(3), /^expected \[1,2\] to have length 3, got 2$/);
    failsWith(() => e2eExpect('ab').not.toHaveLength(2), /not to have length 2/);
    failsWith(() => e2eExpect(42).toHaveLength(2), /numeric length/);
    failsWith(() => e2eExpect({}).toHaveLength(0), /numeric length/);
  });

  it('toHaveProperty walks a dotted or array path, optionally checking the value', () => {
    const user = { name: 'Ada', address: { city: 'London', 'zip.code': 'N1' }, tags: ['a', 'b'], none: undefined };
    e2eExpect(user).toHaveProperty('name');
    e2eExpect(user).toHaveProperty('address.city');
    e2eExpect(user).toHaveProperty('address.city', 'London');
    e2eExpect(user).toHaveProperty(['address', 'zip.code'], 'N1');
    e2eExpect(user).toHaveProperty(['tags', 1], 'b');
    e2eExpect(user).toHaveProperty('tags.0', 'a');
    e2eExpect(user).toHaveProperty('none');
    e2eExpect(user).toHaveProperty('none', undefined);
    e2eExpect(user).toHaveProperty('address', { city: 'London', 'zip.code': 'N1' });
    e2eExpect(user).not.toHaveProperty('age');
    e2eExpect(user).not.toHaveProperty('name', 'Bob');
    failsWith(() => e2eExpect(user).toHaveProperty('address.street'), /to have property "address.street"$/);
    failsWith(() => e2eExpect(user).toHaveProperty('name', 'Bob'), /expected property "name" of .* to equal "Bob", got "Ada"/);
    failsWith(() => e2eExpect(user).toHaveProperty('age', 3), /to have property "age" equal to 3/);
    failsWith(() => e2eExpect(user).not.toHaveProperty('name'), /not to have property "name"/);
    failsWith(() => e2eExpect(user).not.toHaveProperty('name', 'Ada'), /not to equal "Ada"/);
    failsWith(() => e2eExpect(user).toHaveProperty(''), /dotted path/);
    failsWith(() => e2eExpect(null).toHaveProperty('a'), /to have property "a"/);
  });

  it('toHaveProperty reads a primitive on the path through its wrapper, as Jest does', () => {
    const tag = { label: 'abc', count: 3, flag: true, none: null, missing: undefined };
    e2eExpect(tag).toHaveProperty('label.length', 3);
    e2eExpect(tag).toHaveProperty(['label', 0], 'a');
    e2eExpect(tag).toHaveProperty('label.2', 'c');
    e2eExpect(tag).not.toHaveProperty('label.3');
    e2eExpect(tag).not.toHaveProperty('label.length', 4);
    e2eExpect(tag).toHaveProperty('count.toFixed');
    e2eExpect(tag).toHaveProperty('flag.valueOf');
    e2eExpect('abc').toHaveProperty('length', 3);
    e2eExpect(new String('abc')).toHaveProperty('length', 3);
    e2eExpect(tag).toHaveProperty('none', null);
    e2eExpect(tag).not.toHaveProperty('none.length');
    e2eExpect(tag).not.toHaveProperty('missing.length');
    failsWith(() => e2eExpect(tag).toHaveProperty('label.length', 4), /expected property "label.length" of .* to equal 4, got 3/);
    failsWith(() => e2eExpect(tag).toHaveProperty('none.length'), /to have property "none.length"$/);
    failsWith(() => e2eExpect(undefined).toHaveProperty('length'), /to have property "length"/);
  });
});

describe('asymmetric matchers', () => {
  it('expect.any matches classes and primitives', () => {
    e2eExpect(1).toEqual(e2eExpect.any(Number));
    e2eExpect('x').toEqual(e2eExpect.any(String));
    e2eExpect(true).toEqual(e2eExpect.any(Boolean));
    e2eExpect(1n).toEqual(e2eExpect.any(BigInt));
    e2eExpect(Symbol('s')).toEqual(e2eExpect.any(Symbol));
    e2eExpect(() => {}).toEqual(e2eExpect.any(Function));
    e2eExpect({}).toEqual(e2eExpect.any(Object));
    e2eExpect([]).toEqual(e2eExpect.any(Array));
    e2eExpect(new Date()).toEqual(e2eExpect.any(Date));
    e2eExpect(null).toEqual(e2eExpect.any(Object));
    failsWith(() => e2eExpect('1').toEqual(e2eExpect.any(Number)), /to equal Any<Number>$/);
  });

  it('expect.anything matches everything but null and undefined', () => {
    e2eExpect(0).toEqual(e2eExpect.anything());
    e2eExpect('').toEqual(e2eExpect.anything());
    e2eExpect(null).not.toEqual(e2eExpect.anything());
    failsWith(() => e2eExpect(undefined).toEqual(e2eExpect.anything()), /to equal Anything$/);
  });

  it('objectContaining, arrayContaining, stringContaining, stringMatching', () => {
    e2eExpect({ a: 1, b: 2 }).toEqual(e2eExpect.objectContaining({ a: 1 }));
    e2eExpect({ a: { b: 1 } }).toEqual(e2eExpect.objectContaining({ a: { b: 1 } }));
    failsWith(() => e2eExpect({ a: 1 }).toEqual(e2eExpect.objectContaining({ b: 1 })), /ObjectContaining/);
    failsWith(() => e2eExpect({ a: { b: 1, c: 2 } }).toEqual(e2eExpect.objectContaining({ a: { b: 1 } })), /ObjectContaining/);
    e2eExpect([3, 1, 2]).toEqual(e2eExpect.arrayContaining([1, 2]));
    e2eExpect([{ a: 1 }, { a: 2 }]).toEqual(e2eExpect.arrayContaining([{ a: 2 }]));
    failsWith(() => e2eExpect([1]).toEqual(e2eExpect.arrayContaining([1, 2])), /ArrayContaining/);
    e2eExpect('hello world').toEqual(e2eExpect.stringContaining('world'));
    failsWith(() => e2eExpect('hello').toEqual(e2eExpect.stringContaining('world')), /StringContaining "world"/);
    e2eExpect('order #42').toEqual(e2eExpect.stringMatching(/#\d+/));
    e2eExpect('order #42').toEqual(e2eExpect.stringMatching('#42'));
    failsWith(() => e2eExpect(42).toEqual(e2eExpect.stringMatching(/42/)), /StringMatching/);
  });

  it('are honoured inside every structural matcher', () => {
    const payload = { id: 'usr_1', createdAt: new Date(), tags: ['a', 'b'], profile: { name: 'Ada', age: 36 } };
    e2eExpect(payload).toEqual({
      id: e2eExpect.stringMatching(/^usr_/),
      createdAt: e2eExpect.any(Date),
      tags: e2eExpect.arrayContaining(['b']),
      profile: e2eExpect.objectContaining({ name: e2eExpect.any(String) }),
    });
    e2eExpect(payload).toMatchObject({ profile: { age: e2eExpect.any(Number) }, tags: [e2eExpect.any(String), 'b'] });
    e2eExpect([{ id: 1, ok: true }, { id: 2, ok: false }]).toContain(e2eExpect.objectContaining({ id: 2 }));
    e2eExpect(['alpha', 'beta']).toContain(e2eExpect.stringContaining('bet'));
    e2eExpect(payload).toHaveProperty('profile.name', e2eExpect.any(String));
    e2eExpect(payload).toHaveProperty('tags', e2eExpect.arrayContaining(['a']));
    failsWith(() => e2eExpect(payload).toEqual({ id: e2eExpect.any(Number), createdAt: e2eExpect.anything(), tags: ['a', 'b'], profile: e2eExpect.anything() }), /to equal/);
    failsWith(() => e2eExpect(payload).toMatchObject({ profile: { age: e2eExpect.any(String) } }), /to match object/);
    failsWith(() => e2eExpect([{ id: 1 }]).toContain(e2eExpect.objectContaining({ id: 2 })), /to contain/);
    failsWith(() => e2eExpect(payload).toHaveProperty('profile.age', e2eExpect.any(String)), /to equal Any<String>, got 36/);
    failsWith(() => e2eExpect(payload).not.toMatchObject({ id: e2eExpect.any(String) }), /not to match object/);
  });

  it('a matcher on a string toContain is refused like any non-string', () => {
    failsWith(() => e2eExpect('abc').toContain(e2eExpect.stringContaining('a')), /requires a string/);
  });
});

describe('toMatchSchema', () => {
  const User = z.object({ id: z.number(), email: z.email(), role: z.enum(['admin', 'member']).default('member') });

  it('returns the schema output for a matching value, defaults applied', () => {
    const user = e2eExpect<unknown>({ id: 1, email: 'ada@example.com' }).toMatchSchema(User);
    vexpect(user).toEqual({ id: 1, email: 'ada@example.com', role: 'member' });
    vexpect(e2eExpect<unknown>([{ id: 2, email: 'bo@example.com', role: 'admin' }]).toMatchSchema(z.array(User))).toHaveLength(1);
  });

  it('fails listing every issue by its path', () => {
    failsWith(
      () => e2eExpect<unknown>([{ id: 1, email: 'ada@example.com' }, { id: '2', email: 'nope' }]).toMatchSchema(z.array(User)),
      /to match the schema:\n- 1\.id: .+\n- 1\.email: /,
    );
    failsWith(() => e2eExpect<unknown>(null, 'GET /users').toMatchSchema(User), /^GET \/users: expected null to match the schema:\n- /);
  });

  it('negates, returning nothing', () => {
    vexpect(e2eExpect<unknown>({ id: 'x' }).not.toMatchSchema(User)).toBeUndefined();
    failsWith(() => e2eExpect<unknown>({ id: 1, email: 'ada@example.com' }).not.toMatchSchema(User), /not to match the schema/);
  });

  it('refuses a value that is no Standard Schema, and a schema that validates asynchronously', () => {
    vexpect(() => e2eExpect<unknown>({}).toMatchSchema({ '~standard': null } as never)).toThrow(
      vexpect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    vexpect(() => e2eExpect<unknown>({}).toMatchSchema({} as never)).toThrow(
      vexpect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'toMatchSchema schema must implement Standard Schema v1' }),
    );
    const Async = z.string().refine(async () => true);
    vexpect(() => e2eExpect<unknown>('x').toMatchSchema(Async)).toThrow(
      vexpect.objectContaining({ code: 'INVALID_ARGUMENT', message: vexpect.stringContaining('validates asynchronously') }),
    );
  });
});
