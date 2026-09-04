/**
 * LocatorExpression evaluation over one projected transcript: the location
 * capability's query language answered against the messages as they stand
 * right now. One immediate pass, every match in document order; polling,
 * strictness, and staleness stay with the runner.
 */

import { BackendError, matchesText, type LocatorExpression, type SemanticQuery, type TextPattern } from '@e2edev/e2e/backend';
import { isWithin, type ProjectedNode } from './messages.ts';
import { unsupported } from './support.ts';

/** Resolves one expression to the nodes it currently matches. */
export function resolveExpression(expression: LocatorExpression, index: readonly ProjectedNode[]): ProjectedNode[] {
  switch (expression.kind) {
    case 'query': {
      const candidates =
        expression.scope === undefined ? index : descendantsOf(resolveExpression(expression.scope, index), index);
      return candidates.filter((entry) => matchesQuery(entry, expression.query));
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
      throw unsupported('a conversation has no selector language; query messages with getByText or getByRole');
    case 'frame':
      throw new BackendError('FRAME_NOT_FOUND', 'a conversation has no nested documents to scope a query into', {
        retryable: false,
      });
  }
}

/** Strict descendants of any node in `ancestors`, in document order. */
function descendantsOf(ancestors: readonly ProjectedNode[], index: readonly ProjectedNode[]): ProjectedNode[] {
  if (ancestors.length === 0) return [];
  return index.filter((entry) => ancestors.some((ancestor) => isWithin(entry, ancestor)));
}

function ownTexts(entry: ProjectedNode): string[] {
  return [entry.node.name, entry.node.text, entry.node.value].filter((text): text is string => text !== undefined);
}

function subtreeHasText(entry: ProjectedNode, index: readonly ProjectedNode[], pattern: TextPattern): boolean {
  if (ownTexts(entry).some((text) => matchesText(text, pattern))) return true;
  return descendantsOf([entry], index).some((child) => ownTexts(child).some((text) => matchesText(text, pattern)));
}

const STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded'] as const;

/** One node against one semantic query. A message has no placeholder, test id, or display value. */
function matchesQuery(entry: ProjectedNode, query: SemanticQuery): boolean {
  const node = entry.node;
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new BackendError('BACKEND_FAILURE', 'role query value must be a string', { retryable: false });
      }
      if ((node.role ?? '') !== query.value.value) return false;
      if (query.name !== undefined && !matchesText(node.name ?? '', query.name)) return false;
      const wanted = query.states ?? {};
      for (const key of STATE_KEYS) {
        const expected = wanted[key];
        if (expected !== undefined && (node.states?.[key] ?? false) !== expected) return false;
      }
      return true;
    }
    case 'label':
      return node.name !== undefined && matchesText(node.name, query.value);
    case 'text':
      return (
        (node.name !== undefined && matchesText(node.name, query.value)) ||
        (node.text !== undefined && matchesText(node.text, query.value))
      );
    case 'displayValue':
      return node.value !== undefined && matchesText(node.value, query.value);
    case 'placeholder':
    case 'testId':
      return false;
  }
}
