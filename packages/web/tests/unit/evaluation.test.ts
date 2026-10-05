/**
 * The page-side evaluation boundary: the caller's source is inlined into a
 * fresh function, so it must run whatever the loader compiled it to. The tsx
 * loader of e2e before 0.17 emits esbuild `keepNames` output, which
 * references a module-scoped `__name` helper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileEvaluation } from '../../src/evaluation.ts';

describe('compileEvaluation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a keepNames-compiled source that references __name', async () => {
    const evaluate = compileEvaluation(
      'input=>{const pick=__name(key=>input[key],"pick");return pick("a")+pick("b")}',
      true,
    );
    await expect(evaluate({ a: 2, b: 40 })).resolves.toEqual({ ok: true, value: 42 });
  });

  it('gives the wrapped binding the name esbuild kept', async () => {
    const evaluate = compileEvaluation('() => __name(() => 1, "pick").name', false);
    await expect(evaluate(undefined)).resolves.toEqual({ ok: true, value: 'pick' });
  });

  it.each([
    ['document.title', 'Cart'],
    ['(() => document.title)()', 'Cart'],
    ['Promise.resolve(document.title)', 'Cart'],
    ['() => document.title', 'Cart'],
  ])('evaluates a string as an expression, calling a function it evaluates to: %s', async (source, value) => {
    vi.stubGlobal('document', { title: 'Cart' });
    await expect(compileEvaluation(source, false)(undefined)).resolves.toEqual({ ok: true, value });
  });

  it('leaves a page global of any name visible to the source', async () => {
    vi.stubGlobal('result', 'page value');
    vi.stubGlobal('value', 'page value');
    await expect(compileEvaluation('[result, value]', false)(undefined)).resolves.toEqual({
      ok: true,
      value: ['page value', 'page value'],
    });
  });

  it('calls a function expression with the argument', async () => {
    await expect(compileEvaluation('(n) => n + 1', true)(41)).resolves.toEqual({ ok: true, value: 42 });
  });

  it('reports an exception from the evaluated code by message', async () => {
    const evaluate = compileEvaluation('() => { throw new Error("boom"); }', false);
    await expect(evaluate(undefined)).resolves.toEqual({ ok: false, message: 'boom' });
  });
});
