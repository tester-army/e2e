/**
 * LocatorExpression evaluation over one projected snapshot: the location
 * capability's query language answered against the accessibility tree the
 * device just reported. One immediate pass, every match in document order;
 * polling, strictness, and staleness stay with the runner.
 */

import { BackendError, matchesText, type LocatorExpression, type SemanticQuery } from '@e2edev/e2e/backend';
import { isWithin, type ProjectedNode } from './nodes.ts';
import { compileSelector } from './selector.ts';

export interface LocateOptions {
  readonly testIdAttribute: string;
}

/** Resolves one expression to the nodes it currently matches. */
export function resolveExpression(
  expression: LocatorExpression,
  index: readonly ProjectedNode[],
  options: LocateOptions,
): ProjectedNode[] {
  switch (expression.kind) {
    case 'query': {
      const candidates =
        expression.scope === undefined ? index : descendantsOf(resolveExpression(expression.scope, index, options), index);
      return candidates.filter((entry) => matchesQuery(entry, expression.query, options));
    }
    case 'filter': {
      const source = resolveExpression(expression.source, index, options);
      return source.filter((entry) => {
        if (expression.hasText !== undefined && !subtreeHasText(entry, index, expression.hasText)) return false;
        if (expression.has !== undefined) {
          const within = descendantsOf([entry], index);
          if (resolveExpression(expression.has, within, options).length === 0) return false;
        }
        return true;
      });
    }
    case 'index': {
      const source = resolveExpression(expression.source, index, options);
      const position =
        expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
      const picked = source[position];
      return picked === undefined ? [] : [picked];
    }
    case 'selector':
      return compileSelector(expression.selector)(index);
    case 'frame':
      throw new BackendError('FRAME_NOT_FOUND', 'a device surface has no nested documents to scope a query into', {
        retryable: false,
      });
  }
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

const STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded'] as const;

/**
 * One node against one semantic query. Role queries skip hidden nodes unless
 * the query asks for them, as a browser's role query does; the other kinds
 * answer with every node and leave visibility to the action or assertion,
 * unless the query says `visible`, which drops hidden nodes for every kind.
 */
function matchesQuery(entry: ProjectedNode, query: SemanticQuery, options: LocateOptions): boolean {
  const node = entry.node;
  if (query.visible === true && node.states?.hidden === true) return false;
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new BackendError('BACKEND_FAILURE', 'role query value must be a string', { retryable: false });
      }
      if ((node.role ?? '') !== query.value.value) return false;
      if (query.name !== undefined && !matchesText(node.name ?? '', query.name)) return false;
      const wanted = query.states ?? {};
      if (wanted.hidden !== true && node.states?.hidden === true) return false;
      for (const key of STATE_KEYS) {
        const expected = wanted[key];
        if (expected !== undefined && (node.states?.[key] ?? false) !== expected) return false;
      }
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
    case 'testId': {
      const testId = node.attributes?.[options.testIdAttribute];
      return testId !== undefined && matchesText(testId, query.value);
    }
  }
}
