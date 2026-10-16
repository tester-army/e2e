/** Separates exceptions thrown by trusted page code from failures of the evaluation transport. */
import { TestError } from 'e2e/engine';
import { message } from './support.ts';

type EvaluationResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** The `__name` helper tsx's `keepNames` output calls, declared beside test code serialized into the page. */
export const KEEP_NAMES_HELPER = "const __name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });";

/** A function expression for page code, including ordinary and async method shorthand. Never runs it here. */
export function pageFunctionSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString().trim();
  const parse = (text: string) => new Function(`return (${text}\n);`);
  try {
    parse(source);
    return source;
  } catch {
    // Method toString() omits the function keyword; an arrow or function expression already parsed above.
    const ordinary = `function ${source}`;
    let expression: string;
    try {
      parse(ordinary);
      expression = ordinary;
    } catch (cause) {
      if (!/^async\b/.test(source)) {
        throw new TestError('EVALUATE_FAILED', 'page function cannot be serialized', { cause });
      }
      expression = `async function ${source.slice('async'.length)}`;
    }
    try {
      parse(expression);
      return expression;
    } catch (cause) {
      throw new TestError('EVALUATE_FAILED', 'page function cannot be serialized', { cause });
    }
  }
}

/**
 * Compiles the page-side error boundary without evaluating the caller's source in this process.
 * The source is one expression: a function it evaluates to is called with the argument, any
 * other value is the result.
 *
 * A function serialized with `toString()` carries whatever the loader compiled
 * it to. e2e before 0.17 loaded tests through tsx, whose esbuild `keepNames`
 * wraps every nested named binding in a module-scoped `__name(target, name)`
 * helper; the page has no such helper, so the same one is declared next to
 * the inlined source for as long as this engine supports those runners.
 */
export function compileEvaluation(source: string, hasArgument: boolean): (arg: unknown) => Promise<EvaluationResult> {
  try {
    return new Function('arg', `
      return (async () => {
        ${KEEP_NAMES_HELPER}
        try {
          return { ok: true, value: await ((result) => typeof result === 'function' ? result(${hasArgument ? 'arg' : ''}) : result)((${source}\n)) };
        } catch (cause) {
          let message;
          try {
            message = typeof cause?.message === 'string' ? cause.message : String(cause);
          } catch {
            message = 'Page evaluation threw an unprintable value';
          }
          return { ok: false, message };
        }
      })();
    `) as (arg: unknown) => Promise<EvaluationResult>;
  } catch (cause) {
    throw new TestError('EVALUATE_FAILED', message(cause), { cause });
  }
}
