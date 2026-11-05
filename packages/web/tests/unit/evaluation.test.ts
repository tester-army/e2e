/**
 * The page-side evaluation boundary: the caller's source is inlined into a
 * fresh function, so it must run whatever the loader compiled it to. The tsx
 * loader of e2e before 0.17 emits esbuild `keepNames` output, which
 * references a module-scoped `__name` helper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileEvaluation, decodeEvaluation, pageFunctionSource, pageValueEncoder } from '../../src/evaluation.ts';

/** Runs the compiled boundary in this process and decodes its report like `browser.evaluate`. */
async function run(source: string, hasArgument: boolean, arg?: unknown): Promise<unknown> {
  return decodeEvaluation(await compileEvaluation(source, hasArgument)(arg));
}

describe('compileEvaluation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a keepNames-compiled source that references __name', async () => {
    await expect(run('input=>{const pick=__name(key=>input[key],"pick");return pick("a")+pick("b")}', true, { a: 2, b: 40 }))
      .resolves.toBe(42);
  });

  it('gives the wrapped binding the name esbuild kept', async () => {
    await expect(run('() => __name(() => 1, "pick").name', false)).resolves.toBe('pick');
  });

  it.each([
    ['document.title', 'Cart'],
    ['(() => document.title)()', 'Cart'],
    ['Promise.resolve(document.title)', 'Cart'],
    ['() => document.title', 'Cart'],
  ])('evaluates a string as an expression, calling a function it evaluates to: %s', async (source, value) => {
    vi.stubGlobal('document', { title: 'Cart' });
    await expect(run(source, false)).resolves.toBe(value);
  });

  it('leaves a page global of any name visible to the source', async () => {
    vi.stubGlobal('result', 'page value');
    vi.stubGlobal('value', 'page value');
    await expect(run('[result, value]', false)).resolves.toEqual(['page value', 'page value']);
  });

  it('calls a function expression with the argument', async () => {
    await expect(run('(n) => n + 1', true, 41)).resolves.toBe(42);
  });

  it('reports an exception from the evaluated code by message', async () => {
    await expect(run('() => { throw new Error("boom"); }', false)).rejects.toMatchObject({ code: 'EVALUATE_FAILED', message: 'boom' });
  });

  it('reports a result that is not JSON by why', async () => {
    await expect(run('() => [1, undefined]', false)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'evaluate result must be JSON-safe, found undefined',
    });
  });
});

describe('pageValueEncoder', () => {
  const encodePageValue = pageValueEncoder();

  it.each([
    [{ a: [1, 'b', null, true], c: { d: -1.5 } }],
    ['tab\t "quoted" \\ \u0000 \u2028 \ud83d\ude00'],
    [[]],
    [{}],
  ])('encodes JSON text that parses back to the value: %j', (value) => {
    expect(JSON.parse(encodePageValue(value)!)).toEqual(value);
  });

  it('keeps a lone surrogate', () => {
    expect(JSON.parse(encodePageValue('\ud800')!)).toBe('\ud800');
  });

  it.each([
    ['NaN', Number.NaN, 'contains a non-finite number'],
    ['a Date', { when: new Date(0) }, 'must be JSON-safe'],
    ['a Map', [new Map()], 'must be JSON-safe'],
    ['an object with toJSON', new (class { toJSON() { return 1; } })(), 'must be JSON-safe'],
    ['a bigint', { id: 1n }, 'must be JSON-safe, found bigint'],
    ['a symbol', [Symbol('x')], 'must be JSON-safe, found symbol'],
    ['an undefined member', { missing: undefined }, 'must be JSON-safe, found undefined'],
    ['a function', () => 1, 'must be JSON-safe, found function'],
  ])('rejects %s', (_label, value, invalid) => {
    expect(() => encodePageValue(value)).toThrow(expect.objectContaining({ invalid }));
  });

  it('rejects a cycle but not a shared object', () => {
    const shared = { sku: 'a' };
    expect(encodePageValue([shared, shared])).toBe('[{"sku":"a"},{"sku":"a"}]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodePageValue(cyclic)).toThrow(expect.objectContaining({ invalid: 'contains a cycle' }));
  });

  it('encodes a null-prototype object', () => {
    expect(encodePageValue(Object.assign(Object.create(null), { sku: 'a' }))).toBe('{"sku":"a"}');
  });

  it('returns no text for an undefined root', () => {
    expect(encodePageValue(undefined)).toBeUndefined();
  });
});

// The same boundary browser.evaluate and init scripts use for serialized functions.
describe('pageFunctionSource', () => {
  it('evaluates an ordinary method with its argument', async () => {
    const functions = { add(value: number) { return value + 1; } };
    await expect(run(pageFunctionSource(functions.add), true, 41)).resolves.toBe(42);
  });

  it('evaluates an async method with its argument', async () => {
    const functions = { async add(value: number) { return value + 1; } };
    await expect(run(pageFunctionSource(functions.add), true, 41)).resolves.toBe(42);
  });
});
