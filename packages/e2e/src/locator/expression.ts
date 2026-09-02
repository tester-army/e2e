/** Immutable locator expression construction (spec 08-platforms.md). */

import type { LocatorExpression, SemanticQuery } from '../backend/surface.ts';
import { toTextPattern } from '../internal/text.ts';
import { TestError } from '../internal/errors.ts';
import type { Role, RoleOptions, TextMatch, TextMatchOptions } from '../types.ts';

/** Builds a role query expression. */
export function roleQuery(
  role: Role,
  options: RoleOptions | undefined,
  scope: LocatorExpression | undefined,
): LocatorExpression {
  const states: Record<string, boolean> = {};
  for (const key of ['checked', 'disabled', 'selected', 'expanded', 'hidden'] as const) {
    const value = options?.[key];
    if (value !== undefined) states[key] = value;
  }
  const query: SemanticQuery = {
    kind: 'role',
    value: { kind: 'string', value: role, exact: true },
    ...(options?.name !== undefined
      ? { name: toTextPattern(options.name, { exact: options.exact ?? true }) }
      : {}),
    ...(Object.keys(states).length > 0 ? { states } : {}),
  };
  return scoped({ kind: 'query', query }, scope);
}

/** Builds a text-family query expression (label, placeholder, text, displayValue). */
export function textQuery(
  kind: 'label' | 'placeholder' | 'text' | 'displayValue',
  text: TextMatch,
  options: TextMatchOptions | undefined,
  scope: LocatorExpression | undefined,
): LocatorExpression {
  return scoped(
    { kind: 'query', query: { kind, value: toTextPattern(text, { exact: options?.exact ?? true }) } },
    scope,
  );
}

/** Builds a test-id query expression. */
export function testIdQuery(id: string, scope: LocatorExpression | undefined): LocatorExpression {
  return scoped(
    { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: id, exact: true } } },
    scope,
  );
}

function scoped(
  expression: Extract<LocatorExpression, { kind: 'query' }>,
  scope: LocatorExpression | undefined,
): LocatorExpression {
  if (scope === undefined) return expression;
  return { ...expression, scope };
}

/** Builds a filter expression; an empty filter object is an immediate error. */
export function filterExpression(
  source: LocatorExpression,
  options: { hasText?: TextMatch; has?: LocatorExpression },
): LocatorExpression {
  if (options.hasText === undefined && options.has === undefined) {
    throw new TestError('INVALID_LOCATOR', 'filter() requires hasText and/or has');
  }
  return {
    kind: 'filter',
    source,
    ...(options.hasText !== undefined ? { hasText: toTextPattern(options.hasText, { exact: false }) } : {}),
    ...(options.has !== undefined ? { has: options.has } : {}),
  };
}

/** Builds an index expression; negative indices are errors. */
export function indexExpression(
  source: LocatorExpression,
  index: number | 'first' | 'last',
): LocatorExpression {
  if (typeof index === 'number' && (!Number.isInteger(index) || index < 0)) {
    throw new TestError('INVALID_LOCATOR', `nth() index must be a nonnegative integer, got ${index}`);
  }
  return { kind: 'index', source, index };
}

/** Builds a platform-selector expression (CSS or XPath on a document platform). */
export function selectorExpression(selector: string): LocatorExpression {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', 'locator() requires a nonempty selector');
  }
  return { kind: 'selector', selector };
}

/** Renders an expression for diagnostics. */
export function describeExpression(expression: LocatorExpression): string {
  switch (expression.kind) {
    case 'query': {
      const query = expression.query;
      const value =
        query.value.kind === 'string' ? JSON.stringify(query.value.value) : `/${query.value.source}/${query.value.flags}`;
      const name =
        query.name === undefined
          ? ''
          : `, name: ${query.name.kind === 'string' ? JSON.stringify(query.name.value) : `/${query.name.source}/${query.name.flags}`}`;
      const scope = expression.scope === undefined ? '' : `${describeExpression(expression.scope)} >> `;
      return `${scope}getBy${query.kind[0]!.toUpperCase()}${query.kind.slice(1)}(${value}${name})`;
    }
    case 'filter': {
      const parts: string[] = [];
      if (expression.hasText !== undefined) {
        parts.push(
          `hasText: ${expression.hasText.kind === 'string' ? JSON.stringify(expression.hasText.value) : `/${expression.hasText.source}/${expression.hasText.flags}`}`,
        );
      }
      if (expression.has !== undefined) parts.push(`has: ${describeExpression(expression.has)}`);
      return `${describeExpression(expression.source)}.filter({ ${parts.join(', ')} })`;
    }
    case 'index':
      return typeof expression.index === 'number'
        ? `${describeExpression(expression.source)}.nth(${expression.index})`
        : `${describeExpression(expression.source)}.${expression.index}()`;
    case 'selector':
      return `locator(${JSON.stringify(expression.selector)})`;
    case 'frame':
      return `frameLocator(${JSON.stringify(expression.selector)}) >> ${describeExpression(expression.source)}`;
  }
}
