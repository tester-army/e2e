/** Separates exceptions thrown by trusted page code from failures of the evaluation transport. */
import { TestError } from '@e2edev/e2e/backend';
import { message } from './support.ts';

type EvaluationResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Compiles the page-side error boundary without evaluating the caller's source in this process. */
export function compileEvaluation(source: string, hasArgument: boolean): (arg: unknown) => Promise<EvaluationResult> {
  try {
    return new Function('arg', `
      return (async () => {
        try {
          return { ok: true, value: await (${source}\n)(${hasArgument ? 'arg' : ''}) };
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
