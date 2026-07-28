/**
 * Cacheable locator projection (spec 10-determinism.md "Locate replay").
 *
 * `cache-1` admits only semantic locators: a query, a filter, or an index. A
 * locate entry never stores a node reference, coordinate, or CSS/XPath
 * selector. That restriction is a security boundary, not a style preference —
 * a cache file is untrusted repository input, and a semantic query can only
 * ever address something a user could perceive, while a raw selector could
 * reach nodes the observation deliberately withholds.
 */

import type { LocatorExpression, QueryKind, SemanticNode, TextPattern } from '../driver/index.ts';
import { normalizeRegexpFlags } from '../internal/text.ts';

/** Regexp source ceiling in UTF-8 bytes, per 10-determinism.md. */
export const MAX_REGEXP_SOURCE_BYTES = 1_024;

const QUERY_KINDS: ReadonlySet<string> = new Set<QueryKind>([
  'role',
  'label',
  'placeholder',
  'text',
  'displayValue',
  'testId',
]);

const QUERY_STATES = ['checked', 'disabled', 'selected', 'expanded', 'hidden'] as const;

export type CacheQueryStates = Readonly<Partial<Record<(typeof QUERY_STATES)[number], boolean>>>;

export interface CacheQuery {
  readonly kind: QueryKind;
  readonly value: TextPattern;
  readonly name?: TextPattern;
  readonly states?: CacheQueryStates;
}

/**
 * The `cache-1` locator union. It is a structural subset of
 * `LocatorExpression`, so a parsed entry is directly usable for replay without
 * a cast that could smuggle in an unsupported node kind.
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
    };

export interface SemanticIdentity {
  readonly role: string;
  readonly name?: string;
  readonly states?: Readonly<Record<string, boolean>>;
}

export type Projection<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: string };

/**
 * Projects a runner locator onto the cacheable union. Returns a reason instead
 * of throwing, because a non-cacheable locator is an ordinary bypass rather
 * than a test failure: the action still runs, it just is not remembered.
 */
export function toCacheLocator(expression: LocatorExpression): Projection<CacheLocator> {
  switch (expression.kind) {
    case 'web-selector':
      return { ok: false, reason: 'a raw web selector is not a portable semantic locator' };
    case 'frame':
      return {
        ok: false,
        reason: 'a frame chain is addressed by CSS selector, which cache-1 does not admit',
      };
    case 'query': {
      const query = projectQuery(expression.query);
      if (!query.ok) return query;
      if (expression.scope === undefined) {
        return { ok: true, value: { kind: 'query', query: query.value } };
      }
      const scope = toCacheLocator(expression.scope);
      if (!scope.ok) return scope;
      return { ok: true, value: { kind: 'query', query: query.value, scope: scope.value } };
    }
    case 'filter': {
      const source = toCacheLocator(expression.source);
      if (!source.ok) return source;
      let hasText: TextPattern | undefined;
      if (expression.hasText !== undefined) {
        const projected = projectPattern(expression.hasText);
        if (!projected.ok) return projected;
        hasText = projected.value;
      }
      let has: CacheLocator | undefined;
      if (expression.has !== undefined) {
        const projected = toCacheLocator(expression.has);
        if (!projected.ok) return projected;
        has = projected.value;
      }
      if (hasText === undefined && has === undefined) {
        return { ok: false, reason: 'a filter must constrain by text or by a nested locator' };
      }
      return {
        ok: true,
        value: {
          kind: 'filter',
          source: source.value,
          ...(hasText === undefined ? {} : { hasText }),
          ...(has === undefined ? {} : { has }),
        },
      };
    }
    case 'index': {
      const source = toCacheLocator(expression.source);
      if (!source.ok) return source;
      if (typeof expression.index === 'number' && !Number.isSafeInteger(expression.index)) {
        return { ok: false, reason: 'a locator index must be a safe integer' };
      }
      if (typeof expression.index === 'number' && expression.index < 0) {
        return { ok: false, reason: 'a locator index must not be negative' };
      }
      return { ok: true, value: { kind: 'index', source: source.value, index: expression.index } };
    }
  }
}

function projectQuery(query: {
  readonly kind: QueryKind;
  readonly value: TextPattern;
  readonly name?: TextPattern;
  readonly states?: Readonly<Partial<Record<string, boolean>>>;
}): Projection<CacheQuery> {
  if (!QUERY_KINDS.has(query.kind)) {
    return { ok: false, reason: `unsupported query kind "${query.kind}"` };
  }
  const value = projectPattern(query.value);
  if (!value.ok) return value;
  let name: TextPattern | undefined;
  if (query.name !== undefined) {
    const projected = projectPattern(query.name);
    if (!projected.ok) return projected;
    name = projected.value;
  }
  const states = projectStates(query.states);
  return {
    ok: true,
    value: {
      kind: query.kind,
      value: value.value,
      ...(name === undefined ? {} : { name }),
      ...(states === undefined ? {} : { states }),
    },
  };
}

function projectStates(
  states: Readonly<Partial<Record<string, boolean>>> | undefined,
): CacheQueryStates | undefined {
  if (states === undefined) return undefined;
  const present: Record<string, boolean> = {};
  for (const key of QUERY_STATES) {
    const value = states[key];
    if (typeof value === 'boolean') present[key] = value;
  }
  return Object.keys(present).length === 0 ? undefined : present;
}

/**
 * Normalizes one text pattern and enforces the regexp ceilings. An oversized
 * or contradictory pattern makes the entry non-cacheable rather than being
 * silently rewritten, since rewriting could widen what it matches.
 */
function projectPattern(pattern: TextPattern): Projection<TextPattern> {
  if (pattern.kind === 'string') {
    return { ok: true, value: { kind: 'string', value: pattern.value, exact: pattern.exact } };
  }
  const flags = normalizeRegexpFlags(pattern.flags);
  const invalid = validateRegexp(pattern.source, flags);
  if (invalid !== undefined) return { ok: false, reason: invalid };
  return { ok: true, value: { kind: 'regexp', source: pattern.source, flags } };
}

/** Returns a reason when a regexp is not admissible, or undefined when it is. */
export function validateRegexp(source: string, flags: string): string | undefined {
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_REGEXP_SOURCE_BYTES) {
    return `regexp source is ${bytes} bytes, over the ${MAX_REGEXP_SOURCE_BYTES}-byte cache limit`;
  }
  if (flags.includes('u') && flags.includes('v')) {
    return 'regexp flags u and v are mutually exclusive';
  }
  if (normalizeRegexpFlags(flags) !== flags) {
    return `regexp flags "${flags}" are not in canonical order`;
  }
  return undefined;
}

/** Derives the expected semantic identity a replayed node must still match. */
export function toSemanticIdentity(node: SemanticNode): Projection<SemanticIdentity> {
  const role = node.role;
  if (role === undefined || role === '') {
    return { ok: false, reason: 'a cacheable node must expose an explicit role' };
  }
  const name = node.name === undefined ? undefined : node.name.replace(/\s+/gu, ' ').trim();
  const states = node.states === undefined ? undefined : booleanStates(node.states);
  return {
    ok: true,
    value: {
      role,
      ...(name === undefined || name === '' ? {} : { name }),
      ...(states === undefined ? {} : { states }),
    },
  };
}

/**
 * Keeps only the stable states. `focused` and `secure` are excluded: focus
 * moves for reasons unrelated to node identity, and a recorded `secure` flag
 * would make replay depend on a property the expected identity must not assert.
 */
function booleanStates(
  states: Readonly<Partial<Record<string, boolean>>>,
): Readonly<Record<string, boolean>> | undefined {
  const present: Record<string, boolean> = {};
  for (const key of QUERY_STATES) {
    const value = states[key];
    if (typeof value === 'boolean') present[key] = value;
  }
  return Object.keys(present).length === 0 ? undefined : present;
}
