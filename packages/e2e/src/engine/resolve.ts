/**
 * The reference locator semantics over a semantic tree: what `locate`
 * answers for one `LocatorExpression` when the platform's tree is the whole
 * truth. An engine over such a tree (a device's accessibility snapshot, an
 * in-memory fake) calls this instead of interpreting the expression itself;
 * an engine with a native query engine (a browser) reproduces these rules.
 * One immediate pass, every match in document order; polling, strictness,
 * and staleness stay with the runner.
 */

import { matchesText } from '../internal/text.ts';
import {
  EngineError,
  type LocatorExpression,
  type SemanticNode,
  type SemanticQuery,
  type TextPattern,
} from './contract.ts';

export interface ResolveExpressionOptions {
  /**
   * Answers a `selector` expression: the nodes the platform-native selector
   * addresses among `candidates`, in document order. Without it a selector
   * is `UNSUPPORTED_CAPABILITY`, since a semantic tree has no selector
   * language of its own.
   */
  readonly selector?: (selector: string, candidates: readonly SemanticNode[]) => readonly SemanticNode[];
}

/**
 * Resolves one expression to the nodes it currently matches, in document
 * order. `nodes` are the tree's top-level nodes (an observation root's
 * children, or the root itself); every node under them is a candidate.
 *
 * Query kinds: `role` compares the role exactly, then the name, the requested
 * states, and the heading level, and never matches a hidden node; `label`
 * and `text` match the name (`text` the visible text too) and answer with
 * the innermost match, since a container echoing a descendant's text is not
 * a second match; `placeholder`, `displayValue`, and `testId` compare their
 * one field. `visible` drops hidden nodes from any kind. `scope` searches
 * strict descendants of the scope's matches; `filter` keeps a match whose
 * own or descendants' name, text, or value matches `hasText`, and whose
 * descendants answer `has`; `index` picks `first`, `last`, or a position.
 * `frame` is `FRAME_NOT_FOUND`: a semantic tree has no nested documents.
 */
export function resolveExpression(
  expression: LocatorExpression,
  nodes: readonly SemanticNode[],
  options: ResolveExpressionOptions = {},
): SemanticNode[] {
  const tree = indexTree(nodes);
  return resolve(expression, tree.all, tree, options);
}

/** Every node of a tree in document order, with the parent of each. */
interface TreeIndex {
  readonly all: readonly SemanticNode[];
  readonly parents: ReadonlyMap<SemanticNode, SemanticNode>;
}

function indexTree(roots: readonly SemanticNode[]): TreeIndex {
  const all: SemanticNode[] = [];
  const parents = new Map<SemanticNode, SemanticNode>();
  const walk = (node: SemanticNode, parent: SemanticNode | undefined): void => {
    all.push(node);
    if (parent !== undefined) parents.set(node, parent);
    for (const child of node.children ?? []) walk(child, node);
  };
  for (const root of roots) walk(root, undefined);
  return { all, parents };
}

function resolve(
  expression: LocatorExpression,
  candidates: readonly SemanticNode[],
  tree: TreeIndex,
  options: ResolveExpressionOptions,
): SemanticNode[] {
  switch (expression.kind) {
    case 'query': {
      const pool =
        expression.scope === undefined
          ? candidates
          : descendantsOf(resolve(expression.scope, candidates, tree, options), candidates, tree);
      const matches = pool.filter((node) => matchesQuery(node, expression.query));
      return INNERMOST_KINDS.has(expression.query.kind) ? innermostOnly(matches, tree) : matches;
    }
    case 'filter': {
      const source = resolve(expression.source, candidates, tree, options);
      return source.filter((node) => {
        if (expression.hasText !== undefined && !subtreeHasText(node, candidates, tree, expression.hasText)) {
          return false;
        }
        if (expression.has !== undefined) {
          const within = descendantsOf([node], candidates, tree);
          if (resolve(expression.has, within, tree, options).length === 0) return false;
        }
        return true;
      });
    }
    case 'index': {
      const source = resolve(expression.source, candidates, tree, options);
      const position =
        expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
      const picked = source[position];
      return picked === undefined ? [] : [picked];
    }
    case 'selector': {
      if (options.selector === undefined) {
        throw new EngineError(
          'UNSUPPORTED_CAPABILITY',
          `selector ${JSON.stringify(expression.selector)} needs a platform selector language, and this surface has none`,
          { retryable: false },
        );
      }
      return [...options.selector(expression.selector, candidates)];
    }
    case 'frame':
      throw new EngineError(
        'FRAME_NOT_FOUND',
        `no nested document matches ${JSON.stringify(expression.selector)}: this surface has none to scope a query into`,
        { retryable: false },
      );
  }
}

/** The query kinds a container answers for its descendants, so only the innermost match counts. */
const INNERMOST_KINDS: ReadonlySet<SemanticQuery['kind']> = new Set(['text', 'label']);

/**
 * Drops every match that contains another match, the way a browser's text
 * selector answers with the innermost element. A device tree echoes text
 * upwards: iOS reports a React Native Text host view and its StaticText child
 * with the same label, and a container view inherits its descendants' labels,
 * so without this rule every `getByText` on such a screen is ambiguous.
 */
function innermostOnly(matches: readonly SemanticNode[], tree: TreeIndex): SemanticNode[] {
  return matches.filter((node) => !matches.some((other) => other !== node && isWithin(other, node, tree)));
}

/** True when `node` is a strict descendant of `ancestor`. */
function isWithin(node: SemanticNode, ancestor: SemanticNode, tree: TreeIndex): boolean {
  for (let current = tree.parents.get(node); current !== undefined; current = tree.parents.get(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

/** The candidates that are strict descendants of any node in `ancestors`, in document order. */
function descendantsOf(
  ancestors: readonly SemanticNode[],
  candidates: readonly SemanticNode[],
  tree: TreeIndex,
): SemanticNode[] {
  if (ancestors.length === 0) return [];
  return candidates.filter((node) => ancestors.some((ancestor) => isWithin(node, ancestor, tree)));
}

/** Whether the node's own name, text, or value, or a descendant's, matches `pattern`. */
function subtreeHasText(
  node: SemanticNode,
  candidates: readonly SemanticNode[],
  tree: TreeIndex,
  pattern: TextPattern,
): boolean {
  const textsOf = (entry: SemanticNode): (string | undefined)[] => [entry.name, entry.text, entry.value];
  const matchesAny = (entry: SemanticNode): boolean =>
    textsOf(entry).some((text) => text !== undefined && matchesText(text, pattern));
  return matchesAny(node) || descendantsOf([node], candidates, tree).some(matchesAny);
}

/** The states a role query may require, in contract order. */
const STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded', 'pressed'] as const satisfies readonly (keyof NonNullable<
  SemanticQuery['states']
>)[];

/**
 * One node against one semantic query. Role queries skip hidden nodes, as a
 * browser's role query does; the other kinds answer with every node and
 * leave visibility to the action or assertion, unless the query says
 * `visible`, which drops hidden nodes for every kind.
 */
function matchesQuery(node: SemanticNode, query: SemanticQuery): boolean {
  if (query.visible === true && node.states?.hidden === true) return false;
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new EngineError('ENGINE_FAILURE', 'role query value must be a string', { retryable: false });
      }
      if ((node.role ?? '') !== query.value.value) return false;
      if (query.name !== undefined && !matchesText(node.name ?? '', query.name)) return false;
      if (node.states?.hidden === true) return false;
      const wanted = query.states ?? {};
      for (const key of STATE_KEYS) {
        const expected = wanted[key];
        if (expected !== undefined && (node.states?.[key] ?? false) !== expected) return false;
      }
      // A tree without heading levels answers a level query with nothing rather than everything.
      if (query.level !== undefined && node.level !== query.level) return false;
      return true;
    }
    case 'label':
      return node.name !== undefined && matchesText(node.name, query.value);
    case 'placeholder': {
      const placeholder = node.attributes?.['placeholder'];
      return placeholder !== undefined && matchesText(placeholder, query.value);
    }
    case 'text':
      return (
        (node.name !== undefined && matchesText(node.name, query.value)) ||
        (node.text !== undefined && matchesText(node.text, query.value))
      );
    case 'displayValue':
      return node.value !== undefined && matchesText(node.value, query.value);
    case 'testId':
      return node.testId !== undefined && matchesText(node.testId, query.value);
  }
}
