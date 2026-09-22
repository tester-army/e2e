/**
 * The page-side evaluation boundary: the caller's source is inlined into a
 * fresh function, so it must run whatever the loader compiled it to. tsx's
 * esbuild `keepNames` output references a module-scoped `__name` helper.
 */

import { describe, expect, it } from 'vitest';
import { compileEvaluation } from '../../src/evaluation.ts';

describe('compileEvaluation', () => {
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

  it('reports an exception from the evaluated code by message', async () => {
    const evaluate = compileEvaluation('() => { throw new Error("boom"); }', false);
    await expect(evaluate(undefined)).resolves.toEqual({ ok: false, message: 'boom' });
  });
});
