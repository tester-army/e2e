/**
 * Deriving the locator a cache entry stores for one node.
 *
 * Shared by locate replay and path guidance so the rule that keeps the cache
 * from acting on the wrong control has exactly one home.
 *
 * A semantic query comes first: it says what the node is, so it survives the DOM
 * churn — a new wrapper, a reordered container — that invalidates any structural
 * path, and it reads back in a report as something a human wrote.
 *
 * An index-bearing query is the exception, and must not be stored. An index is
 * derived against the match set of the run that resolved it, which makes it
 * correct now and meaningless later: replaying `nth(2)` finds whatever is third
 * next run. Nothing catches that either — an index is only ever needed when the
 * matches are semantically identical, so the recorded role and name match every
 * twin and any identity check passes on the wrong one. That is a wrong action
 * rather than a miss, which is the one thing the cache may not do.
 *
 * The driver's selector is the recordable answer for exactly that node. It is
 * anchored on an attribute that names the element — a test id, a form control's
 * `name` — so unlike an index it still points at the same control after a
 * reorder. Storing it is safe because it is never trusted: a replay resolves it
 * and re-checks before acting, so a stale path costs a miss.
 */

import { asCacheLocator, type CacheLocator } from '../cache/index.ts';
import type { LocatorExpression, SemanticNode } from '../driver/index.ts';
import { frameExpression, webSelectorExpression } from '../locator/expression.ts';
import { deriveQueries } from './queries.ts';

/** The locator to store for one node addressed by an already-derived query. */
export function storableExpression(
  expression: LocatorExpression | undefined,
  node: SemanticNode,
): CacheLocator | undefined {
  if (expression !== undefined && !isPositional(expression)) return asCacheLocator(expression);
  return selectorLocator(node);
}

/**
 * The locator to store for a node the model named directly, with no derived
 * query behind it.
 *
 * The planning tier selects a node by reference rather than by resolving a
 * query, so there is no expression to reuse: the candidates are derived here
 * from the node itself. The first is taken because `deriveQueries` already
 * orders them most-specific first, and it never emits an index, so nothing in
 * that list is positional by construction.
 *
 * Uniqueness is deliberately not checked. A stored locator that later matches
 * several nodes makes the suggestion unusable, and path guidance is advisory —
 * the agent re-decides against a fresh observation — so the cost is a discarded
 * hint rather than a wrong action.
 */
export function storableForNode(
  node: SemanticNode,
  testIdAttribute: string,
): CacheLocator | undefined {
  for (const candidate of deriveQueries(node, testIdAttribute)) {
    if (isPositional(candidate)) continue;
    const locator = asCacheLocator(candidate);
    if (locator !== undefined) return locator;
  }
  return selectorLocator(node);
}

/** The driver selector for one node, scoped behind the frames that reach it. */
function selectorLocator(node: SemanticNode): CacheLocator | undefined {
  const selector = node.selector;
  if (selector === undefined) return undefined;
  // A selector is document-local, so a node inside an iframe is stored behind
  // the chain of frames that reaches its document.
  const framePath = node.framePath ?? [];
  const scoped = framePath.reduceRight<LocatorExpression>(
    (source, frame) => frameExpression(frame, source),
    webSelectorExpression(selector),
  );
  return asCacheLocator(scoped);
}

/**
 * True when an expression addresses its node by position anywhere along the way,
 * so what it resolves to depends on the order of the page rather than on the
 * content of the node.
 */
export function isPositional(expression: LocatorExpression): boolean {
  switch (expression.kind) {
    case 'index':
      return true;
    case 'filter':
    case 'frame':
      return isPositional(expression.source);
    case 'query':
      return expression.scope !== undefined && isPositional(expression.scope);
    default:
      return false;
  }
}
