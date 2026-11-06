/** Runs page functions over WebDriver BiDi `script.callFunction` and converts values across the wire. */

import type { Script } from 'webdriver-bidi-protocol';
import { EngineError } from 'e2e/engine';
import { ScriptError } from '../errors.ts';
import type { BidiConnection } from './connection.ts';

/**
 * A DOM element held by its BiDi shared id, valid for as long as the element
 * lives in its document. A class, so JSON data that happens to carry a
 * `sharedId` is never taken for one.
 */
export class ElementRef {
  constructor(readonly sharedId: string) {}
}

/** A browsing context a page function returned as a window. */
export class WindowRef {
  constructor(readonly context: string) {}
}

/**
 * A page value with no JSON form (a date, a map, a bigint, a function), kept
 * as its type, so a caller that wants JSON refuses it rather than read it as
 * `undefined`.
 */
export class UnreadableValue {
  constructor(readonly type: string) {}
}

/** What a page function may take: JSON values and element references. */
export type PageArgument = string | number | boolean | null | ElementRef | readonly PageArgument[] | { readonly [key: string]: PageArgument };

/** What a page function hands back: JSON values, each DOM node as its reference, each window as its browsing context, anything else as an `UnreadableValue`. */
export type PageValue = string | number | boolean | null | undefined | ElementRef | WindowRef | UnreadableValue | PageValue[] | { [key: string]: PageValue };

/** A page function: a self-contained function serialized with `toString()`, or source composed from one. */
export type PageFunction = string | ((...args: never[]) => unknown);

/** Plain JSON, which crosses the wire as it is. */
export type PageJson = string | number | boolean | null | PageJson[] | { [key: string]: PageJson };

/** A page value as it crosses the wire: each node as its reference, each window as its browsing context. */
export type Wire<T> = T extends PageJson ? T : T extends Node ? ElementRef : T extends Window ? WindowRef : T extends readonly unknown[] ? { [K in keyof T]: Wire<T[K]> } : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

/** A typed page function: self-contained, so its source runs in the page alone. */
export type TypedPageFunction = (...args: never[]) => unknown;

/** How `callFunction` runs a page function. */
export interface CallOptions {
  readonly awaitPromise?: boolean;
  /** Object depth serialized back, `null` for all of it; the default reads two levels, which an array of elements needs. */
  readonly maxObjectDepth?: number | null;
  /** A sandbox realm of the document to run in instead of its main world, out of reach of the page's scripts. */
  readonly sandbox?: string;
}

/**
 * Calls `fn` in the context's main world (or the sandbox `options` names)
 * with `args` and resolves with its return value. A page exception rejects
 * as a `ScriptError` the caller classifies.
 */
export async function callFunction(
  connection: BidiConnection,
  context: string,
  fn: PageFunction,
  args: readonly PageArgument[] = [],
  options: CallOptions = {},
): Promise<PageValue> {
  const result = await connection.send('script.callFunction', {
    functionDeclaration: typeof fn === 'string' ? fn : fn.toString(),
    target: options.sandbox === undefined ? { context } : { context, sandbox: options.sandbox },
    arguments: args.map(toLocalValue),
    awaitPromise: options.awaitPromise ?? false,
    resultOwnership: 'none',
    serializationOptions: { maxDomDepth: 0, maxObjectDepth: options.maxObjectDepth === undefined ? 2 : options.maxObjectDepth, includeShadowTree: 'none' },
  });
  if (result.type === 'exception') throw new ScriptError(result.exceptionDetails.text);
  return fromRemoteValue(result.result);
}

/** One argument as a BiDi local value. */
function toLocalValue(value: PageArgument): Script.LocalValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'number', value: String(value) as 'NaN' };
  if (value instanceof ElementRef) return { sharedId: value.sharedId };
  if (Array.isArray(value)) return { type: 'array', value: value.map(toLocalValue) };
  return { type: 'object', value: Object.entries(value).map(([key, entry]) => [key, toLocalValue(entry as PageArgument)]) };
}

/**
 * One serialized result as a plain value: a node becomes its reference, a
 * window its context, any other type an `UnreadableValue`. Object keys are
 * defined as own properties, so a `__proto__` key in page data is a key. An
 * object the result holds twice arrives once with an `internalId` and then as
 * that id alone; each later mention is the same object, so an alias keeps its
 * contents and a cycle stays a cycle for a JSON check to refuse.
 */
function fromRemoteValue(value: Script.RemoteValue, seen = new Map<string, PageValue>()): PageValue {
  const internalId = 'internalId' in value ? value.internalId : undefined;
  if (internalId !== undefined && !('value' in value && value.value !== undefined) && seen.has(internalId)) return seen.get(internalId);
  switch (value.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return value.value;
    case 'number':
      return typeof value.value === 'number' ? value.value : Number(value.value);
    case 'array': {
      const out: PageValue[] = [];
      if (internalId !== undefined) seen.set(internalId, out);
      for (const entry of value.value ?? []) out.push(fromRemoteValue(entry, seen));
      return out;
    }
    case 'object': {
      const out: Record<string, PageValue> = {};
      if (internalId !== undefined) seen.set(internalId, out);
      for (const [key, entry] of value.value ?? []) {
        if (typeof key === 'string') Object.defineProperty(out, key, { value: fromRemoteValue(entry, seen), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 'window':
      return new WindowRef(value.value.context);
    case 'node':
      if (value.sharedId === undefined) throw new EngineError('NODE_STALE', 'a returned node has no shared id', { retryable: true });
      return new ElementRef(value.sharedId);
    default:
      return new UnreadableValue(value.type);
  }
}
