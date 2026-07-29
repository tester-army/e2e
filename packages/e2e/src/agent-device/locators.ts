/**
 * Evaluates a runner-supplied `LocatorExpression` against a projected mobile
 * snapshot.
 *
 * The driver resolves locators itself rather than delegating to agent-device's
 * selector language: the e2e query model is closed and normative (exact-vs-
 * regexp text, scope, conjunctive filters, index, document order), while
 * agent-device's selector chain is a different vocabulary whose `find` also
 * mutates and whose `wait` adds the hidden retries spec/09-drivers.md forbids.
 */

import { DriverError, type LocatorExpression, type SemanticQuery, type TextPattern } from '../driver/index.ts';
import { queryPlaceholder, queryText, type ProjectedNode, type ProjectedSnapshot } from './snapshot.ts';
import { unsupported } from './support.ts';

/**
 * Normalizes text per spec/03-assertions.md: trim, then collapse every
 * nonempty run of Unicode whitespace to one ASCII space.
 */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/**
 * Matches one candidate string against a text pattern. A string is exact
 * unless `exact: false`, which is case-insensitive substring matching; a
 * regexp uses its ECMAScript source and flags and ignores `exact`.
 */
export function matchesPattern(candidate: string | undefined, pattern: TextPattern): boolean {
  if (candidate === undefined) return false;
  const normalized = normalizeText(candidate);
  if (pattern.kind === 'regexp') {
    // Global and sticky state is reset before every match, so a shared
    // pattern cannot leak lastIndex between candidates.
    const regexp = new RegExp(pattern.source, pattern.flags);
    regexp.lastIndex = 0;
    return regexp.test(normalized);
  }
  const expected = normalizeText(pattern.value);
  if (pattern.exact) return normalized === expected;
  return normalized.toLowerCase().includes(expected.toLowerCase());
}

/** The string a query kind reads from a node, per the spec/16-mobile.md table. */
function querySource(node: ProjectedNode, kind: SemanticQuery['kind']): string | undefined {
  switch (kind) {
    case 'role':
      return node.role;
    case 'label':
      return node.label;
    case 'text':
      return queryText(node);
    case 'displayValue':
      return node.value;
    case 'testId':
      return node.identifier;
    case 'placeholder':
      return queryPlaceholder(node);
  }
}

/**
 * Applies the role-state filters of a query. An unsupported or unavailable
 * state does not match, per spec/08-platforms.md; `expanded` is never available
 * on mobile.
 */
function matchesStates(node: ProjectedNode, query: SemanticQuery): boolean {
  const states = query.states;
  if (states === undefined) return true;
  if (states.expanded !== undefined) return false;
  if (states.checked !== undefined && node.checked !== states.checked) return false;
  if (states.disabled !== undefined && !node.enabled !== states.disabled) return false;
  if (states.selected !== undefined && (node.selected ?? false) !== states.selected) return false;
  return true;
}

function matchesQuery(node: ProjectedNode, query: SemanticQuery): boolean {
  // A hidden node is excluded unless the query explicitly asks for hidden
  // nodes, mirroring the web profile's `hidden` default of false.
  const wantsHidden = query.states?.hidden === true;
  if (!node.visible && !wantsHidden) return false;
  if (query.kind === 'role') {
    if (query.value.kind !== 'string') {
      throw new DriverError('DRIVER_FAILURE', 'role query value must be a string', {
        retryable: false,
      });
    }
    if (node.role !== query.value.value) return false;
    if (query.name !== undefined && !matchesPattern(node.label, query.name)) return false;
    return matchesStates(node, query);
  }
  if (!matchesPattern(querySource(node, query.kind), query.value)) return false;
  return matchesStates(node, query);
}

/** Every descendant of a node, in document order, excluding the node itself. */
function descendants(node: ProjectedNode): ProjectedNode[] {
  const out: ProjectedNode[] = [];
  const walk = (current: ProjectedNode) => {
    for (const child of current.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * Resolves one expression to its matching nodes in document order. Resolution
 * is immediate and never polls; cardinality is the runner's concern.
 */
export function resolveExpression(
  snapshot: ProjectedSnapshot,
  expression: LocatorExpression,
): readonly ProjectedNode[] {
  switch (expression.kind) {
    case 'query': {
      // A scoped query examines descendants and excludes the scope node. Two
      // scopes can reach the same node, so candidates are de-duplicated while
      // keeping document order, which is what `nth` and `count` are defined on.
      let candidates: readonly ProjectedNode[];
      if (expression.scope === undefined) {
        candidates = snapshot.ordered;
      } else {
        const inScope = new Set<string>();
        for (const scope of resolveExpression(snapshot, expression.scope)) {
          for (const node of descendants(scope)) inScope.add(node.ref);
        }
        candidates = snapshot.ordered.filter((node) => inScope.has(node.ref));
      }
      return candidates.filter((node) => matchesQuery(node, expression.query));
    }
    case 'filter': {
      const source = resolveExpression(snapshot, expression.source);
      if (expression.hasText === undefined && expression.has === undefined) {
        throw new DriverError('DRIVER_FAILURE', 'filter requires hasText or has', {
          retryable: false,
        });
      }
      return source.filter((node) => {
        // Both filters are conjunctive when present.
        if (expression.hasText !== undefined) {
          const texts = [node, ...descendants(node)]
            .map((candidate) => queryText(candidate))
            .filter((text): text is string => text !== undefined)
            .join(' ');
          if (!matchesPattern(texts, expression.hasText)) return false;
        }
        if (expression.has !== undefined) {
          const nested = resolveExpression(snapshot, expression.has);
          const within = new Set(descendants(node).map((candidate) => candidate.ref));
          if (!nested.some((candidate) => within.has(candidate.ref))) return false;
        }
        return true;
      });
    }
    case 'index': {
      const source = resolveExpression(snapshot, expression.source);
      if (expression.index === 'first') return source.slice(0, 1);
      if (expression.index === 'last') return source.slice(-1);
      if (expression.index < 0) {
        throw new DriverError('DRIVER_FAILURE', 'negative locator index', { retryable: false });
      }
      const node = source[expression.index];
      return node === undefined ? [] : [node];
    }
    case 'web-selector':
      throw unsupported('CSS selectors; they are a web capability');
    case 'frame':
      throw unsupported('frames; a mobile app has no frame tree');
  }
}
