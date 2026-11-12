/** Separates exceptions thrown by trusted page code from failures of the evaluation transport. */
import type { JsonValue } from 'e2e';
import { TestError } from 'e2e/engine';
import { message } from './support.ts';

/** The `__name` helper tsx's `keepNames` output calls, declared beside test code serialized into the page; it takes `defineProperty` before that code runs. */
export const KEEP_NAMES_HELPER = "const __name = ((define) => (target, value) => define(target, 'name', { value, configurable: true }))(({}).constructor.defineProperty);";

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

/** What the page-side boundary reports, as JSON text: the result, a thrown message, or why the result is not JSON. */
type EvaluationReport =
  | { ok: true; value?: JsonValue }
  | { ok: false; message: string }
  | { ok: false; invalid: string };

/** Thrown by a `pageValueEncoder` encoder for a value that is not JSON; the reason completes `evaluate result ...`. */
interface InvalidPageValue {
  readonly invalid: string;
}

/**
 * Builds, in the page, the encoder of an evaluation result into JSON text.
 * Called before the caller's code runs, it takes the intrinsics it needs from
 * literals, so code that deletes or replaces `Array`, `Object`, or `JSON`
 * cannot reach it. Only JSON passes: `null`, booleans, finite numbers,
 * strings, arrays, and plain objects. Anything else throws `{ invalid }` with
 * the reason `validateJsonValue` gives. Embedded into the page as source, so
 * it captures nothing from this module.
 */
export function pageValueEncoder(): (root: unknown) => string | undefined {
  const { getPrototypeOf, keys } = ({}).constructor as ObjectConstructor;
  const objectPrototype: unknown = getPrototypeOf({});
  const { isArray } = ([] as unknown[]).constructor as ArrayConstructor;
  const charCodeAt = ''.charCodeAt;
  const hex = '0123456789abcdef';
  const invalid = (reason: string): InvalidPageValue => ({ invalid: reason });
  const quote = (text: string): string => {
    let out = '"';
    for (let i = 0; i < text.length; i++) {
      const code = charCodeAt.call(text, i);
      const escape = code === 34 || code === 92 || code < 32 || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff);
      out += escape ? `\\u${hex[code >> 12]}${hex[(code >> 8) & 15]}${hex[(code >> 4) & 15]}${hex[code & 15]}` : text[i];
    }
    return `${out}"`;
  };
  const ancestors: object[] = [];
  const encode = (value: unknown): string => {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'string':
        return quote(value);
      case 'boolean':
        return value ? 'true' : 'false';
      case 'number':
        if (value !== value || value === Infinity || value === -Infinity) throw invalid('contains a non-finite number');
        return `${value}`;
      case 'object':
        break;
      default:
        throw invalid(`must be JSON-safe, found ${typeof value}`);
    }
    const array = isArray(value);
    const prototype: unknown = getPrototypeOf(value);
    if (!array && prototype !== objectPrototype && prototype !== null) throw invalid('must be JSON-safe');
    for (let i = 0; i < ancestors.length; i++) {
      if (ancestors[i] === value) throw invalid('contains a cycle');
    }
    ancestors[ancestors.length] = value;
    let text = '';
    if (array) {
      for (let i = 0; i < value.length; i++) text += `${i === 0 ? '' : ','}${encode(value[i])}`;
      text = `[${text}]`;
    } else {
      const record = value as Record<string, unknown>;
      const names = keys(record);
      for (let i = 0; i < names.length; i++) text += `${i === 0 ? '' : ','}${quote(names[i]!)}:${encode(record[names[i]!])}`;
      text = `{${text}}`;
    }
    ancestors.length -= 1;
    return text;
  };
  return (root) => (root === undefined ? undefined : encode(root));
}

/**
 * Compiles the page-side error boundary without evaluating the caller's source in this process.
 * The source is one expression: a function it evaluates to is called with the argument, any
 * other value is the result. The boundary resolves to JSON text, a primitive the caller takes
 * back without Playwright serializing it in the page, so a page that deleted or replaced a
 * global the serializer needs still returns its result; `decodeEvaluation` reads it.
 *
 * A function serialized with `toString()` carries whatever the loader compiled
 * it to. e2e before 0.17 loaded tests through tsx, whose esbuild `keepNames`
 * wraps every nested named binding in a module-scoped `__name(target, name)`
 * helper; the page has no such helper, so the same one is declared next to
 * the inlined source for as long as this engine supports those runners.
 */
export function compileEvaluation(source: string, hasArgument: boolean): (arg: unknown) => Promise<string> {
  try {
    return new Function('arg', `
      ${KEEP_NAMES_HELPER}
      return (async (encode, run) => {
        const report = (ok, key, text) => \`{"ok":\${ok}\${text === undefined ? '' : \`,"\${key}":\${text}\`}}\`;
        let value;
        try {
          value = await run();
        } catch (cause) {
          let message;
          try {
            message = typeof cause?.message === 'string' ? cause.message : \`\${cause}\`;
          } catch {
            message = 'Page evaluation threw an unprintable value';
          }
          return report(false, 'message', encode(message));
        }
        try {
          return report(true, 'value', encode(value));
        } catch (cause) {
          if (cause !== null && typeof cause === 'object' && typeof cause.invalid === 'string') {
            return report(false, 'invalid', encode(cause.invalid));
          }
          return '{"ok":false,"message":"evaluate result cannot be read"}';
        }
      })((${pageValueEncoder.toString()})(), async () => ((result) => typeof result === 'function' ? result(${hasArgument ? 'arg' : ''}) : result)((${source}\n)));
    `) as (arg: unknown) => Promise<string>;
  } catch (cause) {
    throw new TestError('EVALUATE_FAILED', message(cause), { cause });
  }
}

/** The result of the boundary `compileEvaluation` compiled, from the JSON text it resolved to; throws what the page threw. */
export function decodeEvaluation(text: string): JsonValue | undefined {
  let report: EvaluationReport;
  try {
    // oxlint-disable-next-line e2e/no-unchecked-json -- the text is what compileEvaluation's own boundary wrote
    report = JSON.parse(text) as EvaluationReport;
  } catch (cause) {
    throw new TestError('EVALUATE_FAILED', 'page evaluation returned an unreadable result', { cause });
  }
  if (report.ok) return report.value;
  if ('invalid' in report) throw new TestError('INVALID_ARGUMENT', `evaluate result ${report.invalid}`);
  throw new TestError('EVALUATE_FAILED', report.message);
}
