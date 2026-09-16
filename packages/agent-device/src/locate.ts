/**
 * LocatorExpression evaluation over one projected snapshot: the location
 * capability's query language answered against the accessibility tree the
 * device just reported. One immediate pass, every match in document order;
 * polling, strictness, and staleness stay with the runner.
 */

import { EngineError, matchesText, type LocatorExpression, type SemanticQuery } from 'e2e/engine';
import { isWithin, type ProjectedNode } from './nodes.ts';
import { compileSelector } from './selector.ts';

/** Resolves one expression to the nodes it currently matches. */
export function resolveExpression(expression: LocatorExpression, index: readonly ProjectedNode[]): ProjectedNode[] {
  switch (expression.kind) {
    case 'query': {
      const candidates =
        expression.scope === undefined ? index : descendantsOf(resolveExpression(expression.scope, index), index);
      const matches = candidates.filter((entry) => matchesQuery(entry, expression.query));
      return expression.query.kind === 'text' ? innermostOnly(matches) : matches;
    }
    case 'filter': {
      const source = resolveExpression(expression.source, index);
      return source.filter((entry) => {
        if (expression.hasText !== undefined && !subtreeHasText(entry, index, expression.hasText)) return false;
        if (expression.has !== undefined) {
          const within = descendantsOf([entry], index);
          if (resolveExpression(expression.has, within).length === 0) return false;
        }
        return true;
      });
    }
    case 'index': {
      const source = resolveExpression(expression.source, index);
      const position =
        expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
      const picked = source[position];
      return picked === undefined ? [] : [picked];
    }
    case 'selector':
      return compileSelector(expression.selector)(index);
    case 'frame':
      throw new EngineError('FRAME_NOT_FOUND', 'a device surface has no nested documents to scope a query into', {
        retryable: false,
      });
  }
}

/**
 * Drops every match that contains another match, the way a browser's text
 * selector answers with the innermost element. A device tree echoes text
 * upwards: iOS reports a React Native Text host view and its StaticText child
 * with the same label, and a container view inherits its descendants' labels,
 * so without this rule every `getByText` on such a screen is ambiguous.
 */
function innermostOnly(matches: readonly ProjectedNode[]): ProjectedNode[] {
  return matches.filter((entry) => !matches.some((other) => other !== entry && isWithin(other, entry)));
}

/** Strict descendants of any node in `ancestors`, in document order. */
function descendantsOf(ancestors: readonly ProjectedNode[], index: readonly ProjectedNode[]): ProjectedNode[] {
  if (ancestors.length === 0) return [];
  return index.filter((entry) => ancestors.some((ancestor) => isWithin(entry, ancestor)));
}

function subtreeHasText(
  entry: ProjectedNode,
  index: readonly ProjectedNode[],
  pattern: NonNullable<Extract<LocatorExpression, { kind: 'filter' }>['hasText']>,
): boolean {
  const ownTexts = [entry.node.name, entry.node.text, entry.node.value];
  if (ownTexts.some((text) => text !== undefined && matchesText(text, pattern))) return true;
  return descendantsOf([entry], index).some((child) =>
    [child.node.name, child.node.text, child.node.value].some((text) => text !== undefined && matchesText(text, pattern)),
  );
}

const STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded', 'pressed'] as const;

/**
 * One node against one semantic query. Role queries skip hidden nodes, as a
 * browser's role query does; the other kinds
 * answer with every node and leave visibility to the action or assertion,
 * unless the query says `visible`, which drops hidden nodes for every kind.
 */
function matchesQuery(entry: ProjectedNode, query: SemanticQuery): boolean {
  const node = entry.node;
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
      // A device tree reports no heading levels, so a level query matches nothing rather than everything.
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
