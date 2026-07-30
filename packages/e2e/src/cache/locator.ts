/**
 * The cacheable locator shape (spec 10-determinism.md "Locate replay").
 *
 * `cache-1` admits a closed union: a semantic query, a filter, an index, a
 * platform selector, and an iframe boundary. It never admits a node reference,
 * a coordinate, model prose, an instruction, or a secret. So nothing an entry
 * can express carries live state from the run that wrote it, and nothing it can
 * express is ever shown to a model on the run that reads it — an entry is input
 * to the locator engine and to nothing else.
 *
 * Within the union a semantic query is always preferred, and not only because it
 * survives DOM churn: a query can address only something a user could perceive.
 * A platform selector cannot make that promise. It is arbitrary CSS, and the
 * identity check on replay constrains what the resolved node must *be*, not
 * which nodes the selector may reach. It is admitted anyway because the node it
 * exists for — a control the page repeats verbatim, where every twin is
 * semantically identical — is addressable only by an index, which is measured
 * against one run's match set and so cannot be replayed on the next. Without the
 * selector such a node would pay a model locate on every run. What that concedes against a hostile entry is
 * stated in 10-determinism.md "Storage and concurrency".
 *
 * One function enforces it in both directions. `asCacheLocator` accepts
 * `unknown`, so the same code path checks an expression the runner just derived
 * and a document it just read off disk. There is no second implementation to
 * drift from, which is why there is no schema-agreement test either.
 */

import type { QueryKind, SemanticNode, TextPattern } from '../driver/index.ts';
import { normalizeRegexpFlags, normalizeText } from '../internal/text.ts';

/** Regexp source ceiling in UTF-8 bytes, per 10-determinism.md. */
const MAX_REGEXP_SOURCE_BYTES = 1_024;

const QUERY_KINDS: ReadonlySet<string> = new Set<QueryKind>([
  'role',
  'label',
  'placeholder',
  'text',
  'displayValue',
  'testId',
]);

const QUERY_STATES: ReadonlySet<string> = new Set([
  'checked',
  'disabled',
  'selected',
  'expanded',
  'hidden',
]);

export interface CacheQuery {
  readonly kind: QueryKind;
  readonly value: TextPattern;
  readonly name?: TextPattern;
  readonly states?: Readonly<Record<string, boolean>>;
}

/**
 * The `cache-1` locator union: a structural subset of `LocatorExpression`, so a
 * validated locator is directly usable for replay without a cast that could
 * smuggle in an unsupported node kind.
 */
export type CacheLocator =
  | { readonly kind: 'query'; readonly query: CacheQuery; readonly scope?: CacheLocator }
  | {
      readonly kind: 'filter';
      readonly source: CacheLocator;
      readonly hasText?: TextPattern;
      readonly has?: CacheLocator;
    }
  | {
      readonly kind: 'index';
      readonly source: CacheLocator;
      readonly index: number | 'first' | 'last';
    }
  /**
   * A platform selector the driver reported for an observed node. Structural
   * rather than semantic, so it re-finds a node whose text has changed and a
   * node no query can single out — and it is only ever a guess, because the
   * identity behind it is checked before the entry is used.
   */
  | { readonly kind: 'web-selector'; readonly selector: string }
  /**
   * One iframe boundary along the way to the node. Without it a node inside an
   * embedded document could not be stored at all, because neither a query nor a
   * selector reaches across a frame on its own.
   */
  | { readonly kind: 'frame'; readonly selector: string; readonly source: CacheLocator };

/**
 * What a replayed node must still be. Role and name are both optional but at
 * least one is required: a node with neither is indistinguishable from any other
 * and cannot be verified, so it is not stored. Requiring a role would have left
 * every unlabelled container — a drag handle, a hover zone — permanently
 * uncacheable even though its accessible name identifies it perfectly.
 */
export interface SemanticIdentity {
  readonly role?: string;
  readonly name?: string;
}

/**
 * Validates one value as a cacheable locator, or returns undefined with no
 * explanation of which field failed.
 *
 * A rejection is never a test failure: on the write side the action still runs
 * and simply is not remembered, and on the read side it is an ordinary miss.
 * Callers that want to tell the user why report the shape they were given.
 */
export function asCacheLocator(value: unknown): CacheLocator | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  switch (raw['kind']) {
    case 'query': {
      const query = asQuery(raw['query']);
      if (query === undefined) return undefined;
      if (raw['scope'] === undefined) return { kind: 'query', query };
      const scope = asCacheLocator(raw['scope']);
      return scope === undefined ? undefined : { kind: 'query', query, scope };
    }
    case 'filter': {
      const source = asCacheLocator(raw['source']);
      if (source === undefined) return undefined;
      const hasText = optional(raw['hasText'], asPattern);
      const has = optional(raw['has'], asCacheLocator);
      // A filter that constrains nothing is the source, and admitting it would
      // let one entry stand for two different locators.
      if (hasText === undefined && has === undefined) return undefined;
      if (hasText === null || has === null) return undefined;
      return {
        kind: 'filter',
        source,
        ...(hasText === undefined ? {} : { hasText }),
        ...(has === undefined ? {} : { has }),
      };
    }
    case 'index': {
      const source = asCacheLocator(raw['source']);
      if (source === undefined) return undefined;
      const index = raw['index'];
      const valid =
        index === 'first' ||
        index === 'last' ||
        (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0);
      return valid ? { kind: 'index', source, index: index as number | 'first' | 'last' } : undefined;
    }
    case 'web-selector': {
      const selector = raw['selector'];
      return typeof selector === 'string' && selector !== ''
        ? { kind: 'web-selector', selector }
        : undefined;
    }
    case 'frame': {
      const selector = raw['selector'];
      const source = asCacheLocator(raw['source']);
      return typeof selector === 'string' && selector !== '' && source !== undefined
        ? { kind: 'frame', selector, source }
        : undefined;
    }
    default:
      return undefined;
  }
}

function asQuery(value: unknown): CacheQuery | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !QUERY_KINDS.has(kind)) return undefined;
  const pattern = asPattern(raw['value']);
  if (pattern === undefined) return undefined;
  const name = optional(raw['name'], asPattern);
  if (name === null) return undefined;
  const states = optional(raw['states'], asStates);
  if (states === null) return undefined;
  return {
    kind: kind as QueryKind,
    value: pattern,
    ...(name === undefined ? {} : { name }),
    ...(states === undefined ? {} : { states }),
  };
}

/** Keeps only the admitted states, dropping anything else. */
function asStates(value: unknown): Readonly<Record<string, boolean>> | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const states: Record<string, boolean> = {};
  for (const [name, flag] of Object.entries(raw)) {
    if (typeof flag === 'boolean' && QUERY_STATES.has(name)) states[name] = flag;
  }
  return Object.keys(states).length === 0 ? undefined : states;
}

/**
 * Validates one text pattern. Regexp flags are normalized to canonical order
 * and an oversized source is refused, because replay evaluates the pattern.
 */
function asPattern(value: unknown): TextPattern | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (raw['kind'] === 'string') {
    const text = raw['value'];
    if (typeof text !== 'string' || typeof raw['exact'] !== 'boolean') return undefined;
    return { kind: 'string', value: text, exact: raw['exact'] };
  }
  if (raw['kind'] !== 'regexp') return undefined;
  const source = raw['source'];
  const flags = raw['flags'];
  if (typeof source !== 'string' || typeof flags !== 'string') return undefined;
  if (new TextEncoder().encode(source).byteLength > MAX_REGEXP_SOURCE_BYTES) return undefined;
  const canonical = normalizeRegexpFlags(flags);
  if (canonical.includes('u') && canonical.includes('v')) return undefined;
  return { kind: 'regexp', source, flags: canonical };
}

/**
 * Derives the expected identity a replayed node must still match. Role and name
 * only: states are re-checked by actionability before the action runs, so
 * storing them would just add ways to miss.
 */
export function toSemanticIdentity(node: SemanticNode): SemanticIdentity | undefined {
  const role = node.role === undefined || node.role === '' ? undefined : node.role;
  const named = node.name === undefined ? undefined : normalizeText(node.name);
  const name = named === undefined || named === '' ? undefined : named;
  if (role === undefined && name === undefined) return undefined;
  return { ...(role === undefined ? {} : { role }), ...(name === undefined ? {} : { name }) };
}

/** Validates a stored expected identity. */
export function asSemanticIdentity(value: unknown): SemanticIdentity | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const role = raw['role'];
  if (role !== undefined && (typeof role !== 'string' || role === '')) return undefined;
  const name = raw['name'];
  if (name !== undefined && (typeof name !== 'string' || name === '')) return undefined;
  if (role === undefined && name === undefined) return undefined;
  return {
    ...(role === undefined ? {} : { role: role as string }),
    ...(name === undefined ? {} : { name: name as string }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Applies `check` to an optional field. Returns undefined when absent and null
 * when present but invalid, so a caller can tell "not there" from "not valid".
 */
function optional<Value>(
  value: unknown,
  check: (input: unknown) => Value | undefined,
): Value | undefined | null {
  if (value === undefined) return undefined;
  return check(value) ?? null;
}
