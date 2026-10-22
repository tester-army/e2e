/**
 * `x-` keys: a customer's own data on any object a CIGE file defines, such
 * as `"x-owner"` on the case or `"x-deny-host"` on a guardrail. They are
 * taken off before the strict schema judges the file, so any other unknown
 * key still fails to load, and put back on the normalized case as
 * `extensions`. The runner never sends them to the model; a plugin's
 * `context` hook is the one way in. Free-form values (a step's `params` or
 * `with`, a variant's `params`, an `x-` value itself) are left as written.
 */

/** The `x-` keys of one object, as written. */
export type CigeExtensions = Readonly<Record<string, unknown>>;

const EXTENSION_KEY = /^x-[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One object without its `x-` keys, and the keys taken. A key that starts
 * with `x-` but is malformed stays, for the schema to report.
 */
function split(value: unknown): { readonly rest: unknown; readonly extensions?: CigeExtensions } {
  if (!isRecord(value)) return { rest: value };
  const rest: Record<string, unknown> = {};
  const extensions: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (EXTENSION_KEY.test(key)) extensions[key] = entry;
    else rest[key] = entry;
  }
  return Object.keys(extensions).length === 0 ? { rest } : { rest, extensions };
}

/**
 * Takes the `x-` keys off every object a CIGE file defines, by position,
 * and returns the file without them and the keys taken, by path: `''` for
 * the case, then `Context`, `Context.preconditions.<i>`, `Intent`,
 * `Intent.evidence.<i>`, `Guardrails.<i>`, `Guardrails.<i>.deny`,
 * `Execution.<i>`, and `Variants.<i>`. The input is not changed.
 */
export function extractExtensions(file: unknown): { readonly file: unknown; readonly at: ReadonlyMap<string, CigeExtensions> } {
  const at = new Map<string, CigeExtensions>();
  const take = (value: unknown, path: string): unknown => {
    const { rest, extensions } = split(value);
    if (extensions !== undefined) at.set(path, extensions);
    return rest;
  };
  const each = (list: unknown, path: string, inner?: (entry: unknown, entryPath: string) => unknown): unknown =>
    Array.isArray(list) ? list.map((entry, index) => (inner ?? take)(entry, `${path}.${index}`)) : list;

  const root = take(file, '');
  if (!isRecord(root)) return { file: root, at };
  const out: Record<string, unknown> = { ...root };
  if ('Context' in out) {
    const context = take(out.Context, 'Context');
    out.Context = isRecord(context) && 'preconditions' in context ? { ...context, preconditions: each(context.preconditions, 'Context.preconditions') } : context;
  }
  if ('Intent' in out) {
    const intent = take(out.Intent, 'Intent');
    out.Intent = isRecord(intent) && 'evidence' in intent ? { ...intent, evidence: each(intent.evidence, 'Intent.evidence') } : intent;
  }
  if ('Guardrails' in out) {
    out.Guardrails = each(out.Guardrails, 'Guardrails', (entry, path) => {
      const guardrail = take(entry, path);
      return isRecord(guardrail) && 'deny' in guardrail ? { ...guardrail, deny: take(guardrail.deny, `${path}.deny`) } : guardrail;
    });
  }
  if ('Execution' in out) out.Execution = each(out.Execution, 'Execution');
  if ('Variants' in out) out.Variants = each(out.Variants, 'Variants');
  return { file: out, at };
}
