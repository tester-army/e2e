/**
 * The reference locator semantics: what `locate` answers for one
 * `LocatorExpression`. `createResolver` holds the rules every engine shares
 * (unions, scopes, filters, positions, the innermost rule) over whatever its
 * platform reads; it is self-contained, so a browser engine serializes it
 * into the page and resolves there. `resolveExpression` runs it over a
 * semantic tree, for an engine whose tree is the whole truth (a device's
 * accessibility snapshot, an in-memory fake). One immediate pass, every
 * match in the platform's order; polling, strictness, and staleness stay
 * with the runner.
 */

import { matchesText } from '../internal/text.ts';
import {
  EngineError,
  type LocatorExpression,
  type SemanticNode,
  type SemanticQuery,
  type TextPattern,
} from './contract.ts';

/** What the locator rules read of a platform's nodes. */
export interface ResolverPlatform<N> {
  /** Every node, in the order matches come in and `nth` counts by. */
  readonly nodes: readonly N[];
  /** The node's parent among `nodes`, undefined for a root. */
  parent(node: N): N | undefined;
  /** Whether `node` matches `query` by the platform's rules. */
  matches(node: N, query: SemanticQuery): boolean;
  /** Whether a `filter({ hasText })` keeps `node`. */
  hasText(node: N, pattern: TextPattern): boolean;
  /** The nodes among `candidates` a platform-native selector addresses, in their order. */
  selector(selector: string, candidates: readonly N[]): readonly N[];
  /** Throws the platform's error for a locator that cannot resolve. */
  fail(code: 'FRAME_NOT_FOUND', message: string): never;
}

/**
 * The locator rules over one platform: a function from an expression to the
 * nodes it matches, in `platform.nodes` order, but a union's, which come in
 * document order (each node before its children, a parent's children in
 * `platform.nodes` order), as Playwright orders `or`. `text` and `label` queries
 * answer with the innermost match, since a container echoing a descendant's
 * text is not a second match; `scope` searches strict descendants of the
 * scope's matches; `filter` keeps a match whose own or descendants' text
 * answers `hasText` and whose descendants answer `has`, each `has` resolved
 * among that match's descendants alone; `index` picks `first`, `last`, or a
 * position. Linear in the nodes for every kind but `has`, which reads each
 * match's subtree once. Serialized with `toString()`, so it closes over
 * nothing of this module.
 */
export function createResolver<N>(platform: ResolverPlatform<N>): (expression: LocatorExpression) => N[] {
  const INNERMOST_KINDS = new Set(['text', 'label']);
  /** The tree the nodes form; built the first time a union or a `has` asks. */
  interface TreeIndex {
    /** Each node's place in `platform.nodes`. */
    readonly position: Map<N, number>;
    /** Each node's children, in `platform.nodes` order. */
    readonly children: Map<N, N[]>;
    /** Each node's place in document order. */
    readonly rank: Map<N, number>;
  }
  let tree: TreeIndex | undefined;
  const treeIndex = (): TreeIndex => {
    if (tree !== undefined) return tree;
    const position = new Map<N, number>();
    const children = new Map<N, N[]>();
    const roots: N[] = [];
    platform.nodes.forEach((node, index) => {
      position.set(node, index);
      const parent = platform.parent(node);
      if (parent === undefined) {
        roots.push(node);
        return;
      }
      const siblings = children.get(parent);
      if (siblings === undefined) children.set(parent, [node]);
      else siblings.push(node);
    });
    const rank = new Map<N, number>();
    const stack = roots.toReversed();
    while (stack.length > 0) {
      const node = stack.pop() as N;
      rank.set(node, rank.size);
      const below = children.get(node);
      if (below !== undefined) for (let index = below.length - 1; index >= 0; index -= 1) stack.push(below[index] as N);
    }
    tree = { position, children, rank };
    return tree;
  };

  /** Drops every match that holds another match: each match marks its ancestors once. */
  const innermostOnly = (matches: readonly N[]): N[] => {
    const holders = new Set<N>();
    for (const match of matches) {
      for (let at = platform.parent(match); at !== undefined && !holders.has(at); at = platform.parent(at)) holders.add(at);
    }
    return matches.filter((match) => !holders.has(match));
  };

  /** The candidates that are strict descendants of a node in `ancestors`, each parent chain walked once. */
  const descendantsOf = (ancestors: readonly N[], candidates: readonly N[]): N[] => {
    if (ancestors.length === 0) return [];
    const scopes = new Set(ancestors);
    const known = new Map<N, boolean>();
    const isInside = (node: N): boolean => {
      const chain: N[] = [];
      let inside = false;
      for (let at: N | undefined = node; at !== undefined; ) {
        const answer = known.get(at);
        if (answer !== undefined) {
          inside = answer;
          break;
        }
        chain.push(at);
        at = platform.parent(at);
        if (at !== undefined && scopes.has(at)) {
          inside = true;
          break;
        }
      }
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        known.set(chain[index] as N, inside);
        inside ||= scopes.has(chain[index] as N);
      }
      return known.get(node) === true;
    };
    return candidates.filter(isInside);
  };

  /** The strict descendants of `node`, in `platform.nodes` order. */
  const subtreeOf = (node: N): N[] => {
    const { position, children } = treeIndex();
    const out: N[] = [];
    const stack = [...(children.get(node) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as N;
      out.push(at);
      stack.push(...(children.get(at) ?? []));
    }
    return out.toSorted((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  };

  const resolve = (expression: LocatorExpression, candidates: readonly N[]): N[] => {
    switch (expression.kind) {
      case 'union': {
        const matches = new Set([...resolve(expression.left, candidates), ...resolve(expression.right, candidates)]);
        const { rank } = treeIndex();
        return candidates.filter((node) => matches.has(node)).toSorted((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      }
      case 'query': {
        const pool = expression.scope === undefined ? candidates : descendantsOf(resolve(expression.scope, candidates), candidates);
        const matches = pool.filter((node) => platform.matches(node, expression.query));
        return INNERMOST_KINDS.has(expression.query.kind) ? innermostOnly(matches) : matches;
      }
      case 'filter': {
        const source = resolve(expression.source, candidates);
        const { has, hasNot, hasText, hasNotText } = expression;
        const pool = has === undefined && hasNot === undefined ? undefined : new Set(candidates);
        return source.filter((node) => {
          if (hasText !== undefined && !platform.hasText(node, hasText)) return false;
          if (hasNotText !== undefined && platform.hasText(node, hasNotText)) return false;
          if (pool !== undefined) {
            const within = subtreeOf(node).filter((each) => pool.has(each));
            if (has !== undefined && resolve(has, within).length === 0) return false;
            if (hasNot !== undefined && resolve(hasNot, within).length > 0) return false;
          }
          return true;
        });
      }
      case 'index': {
        const source = resolve(expression.source, candidates);
        const at = expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
        const picked = source[at];
        return picked === undefined ? [] : [picked];
      }
      case 'selector':
        return [...platform.selector(expression.selector, candidates)];
      case 'frame':
        return platform.fail('FRAME_NOT_FOUND', `no nested document matches ${JSON.stringify(expression.selector)}: this surface has none to scope a query into`);
    }
  };

  return (expression) => resolve(expression, platform.nodes);
}

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
 * and `text` match the name (`text` the visible text too); `placeholder`,
 * `displayValue`, and `testId` compare their one field. `visible` drops
 * hidden nodes from any kind. A `hasText` filter reads the node's and its
 * descendants' name, text, and value. `frame` is `FRAME_NOT_FOUND`: a
 * semantic tree has no nested documents.
 */
export function resolveExpression(
  expression: LocatorExpression,
  nodes: readonly SemanticNode[],
  options: ResolveExpressionOptions = {},
): SemanticNode[] {
  const all: SemanticNode[] = [];
  const parents = new Map<SemanticNode, SemanticNode>();
  const walk = (node: SemanticNode, parent: SemanticNode | undefined): void => {
    all.push(node);
    if (parent !== undefined) parents.set(node, parent);
    for (const child of node.children ?? []) walk(child, node);
  };
  for (const root of nodes) walk(root, undefined);
  return createResolver<SemanticNode>({
    nodes: all,
    parent: (node) => parents.get(node),
    matches: matchesQuery,
    hasText: subtreeHasText,
    selector: (selector, candidates) => {
      if (options.selector === undefined) {
        throw new EngineError(
          'UNSUPPORTED_CAPABILITY',
          `selector ${JSON.stringify(selector)} needs a platform selector language, and this surface has none`,
          { retryable: false },
        );
      }
      return options.selector(selector, candidates);
    },
    fail: (code, message) => {
      throw new EngineError(code, message, { retryable: false });
    },
  })(expression);
}

/** Whether the node's own name, text, or value, or a descendant's, matches `pattern`. */
function subtreeHasText(node: SemanticNode, pattern: TextPattern): boolean {
  if ([node.name, node.text, node.value].some((text) => text !== undefined && matchesText(text, pattern))) return true;
  return (node.children ?? []).some((child) => subtreeHasText(child, pattern));
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
