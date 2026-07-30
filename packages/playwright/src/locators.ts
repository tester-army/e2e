/** LocatorExpression -> Playwright locator projection. */

import type { FrameLocator, Locator as PwLocator, Page } from 'playwright';
import { DriverError, type LocatorExpression, type SemanticQuery, type TextPattern } from 'e2e/driver';

type PwScope = Page | FrameLocator | PwLocator;

function patternToPw(pattern: TextPattern): string | RegExp {
  if (pattern.kind === 'regexp') return new RegExp(pattern.source, pattern.flags);
  return pattern.value;
}

function patternExact(pattern: TextPattern): boolean {
  return pattern.kind === 'string' ? pattern.exact : false;
}

function queryToPw(scope: PwScope, query: SemanticQuery): PwLocator {
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new DriverError('DRIVER_FAILURE', 'role query value must be a string', {
          retryable: false,
        });
      }
      const options: Parameters<Page['getByRole']>[1] = {};
      if (query.name !== undefined) {
        options.name = patternToPw(query.name);
        if (query.name.kind === 'string') options.exact = query.name.exact;
      }
      const states = query.states ?? {};
      if (states.checked !== undefined) options.checked = states.checked;
      if (states.disabled !== undefined) options.disabled = states.disabled;
      if (states.selected !== undefined) options.selected = states.selected;
      if (states.expanded !== undefined) options.expanded = states.expanded;
      if (states.hidden !== undefined) options.includeHidden = states.hidden;
      return scope.getByRole(query.value.value as Parameters<Page['getByRole']>[0], options);
    }
    case 'label':
      return scope.getByLabel(patternToPw(query.value), { exact: patternExact(query.value) });
    case 'placeholder':
      return scope.getByPlaceholder(patternToPw(query.value), { exact: patternExact(query.value) });
    case 'text':
      return scope.getByText(patternToPw(query.value), { exact: patternExact(query.value) });
    case 'displayValue':
      // Candidate set; the session filters by current value at resolve time.
      return scope.locator('input, textarea, select');
    case 'testId':
      return scope.getByTestId(patternToPw(query.value));
  }
}

export interface ProjectedLocator {
  readonly locator: PwLocator;
  /** Non-null when the terminal query filters by display value. */
  readonly displayValue: TextPattern | null;
}

/**
 * Projects a complete immutable expression onto a Playwright locator within
 * one scope. Frame cardinality is validated separately by the session.
 */
function project(scope: PwScope, expression: LocatorExpression): ProjectedLocator {
  switch (expression.kind) {
    case 'query': {
      const inner =
        expression.scope === undefined ? scope : requireSingle(project(scope, expression.scope));
      return {
        locator: queryToPw(inner, expression.query),
        displayValue: expression.query.kind === 'displayValue' ? expression.query.value : null,
      };
    }
    case 'filter': {
      const source = requireSingle(project(scope, expression.source));
      const options: Parameters<PwLocator['filter']>[0] = {};
      if (expression.hasText !== undefined) options.hasText = patternToPw(expression.hasText);
      if (expression.has !== undefined) {
        options.has = requireSingle(project(scope, expression.has));
      }
      return { locator: source.filter(options), displayValue: null };
    }
    case 'index': {
      const source = requireSingle(project(scope, expression.source));
      const locator =
        expression.index === 'first'
          ? source.first()
          : expression.index === 'last'
            ? source.last()
            : source.nth(expression.index);
      return { locator, displayValue: null };
    }
    case 'web-selector':
      return { locator: scope.locator(expression.selector), displayValue: null };
    case 'frame':
      return project(scope.frameLocator(expression.selector), expression.source);
  }
}

/** Projects an expression onto the page. */
export function projectExpression(page: Page, expression: LocatorExpression): ProjectedLocator {
  return project(page, expression);
}

function requireSingle(projected: ProjectedLocator): PwLocator {
  if (projected.displayValue !== null) {
    throw new DriverError(
      'UNSUPPORTED_CAPABILITY',
      'displayValue queries cannot be used as scopes or filters in this driver',
      { retryable: false },
    );
  }
  return projected.locator;
}

/** Returns every frame selector along an expression, outermost first. */
export function frameSelectors(expression: LocatorExpression): string[] {
  switch (expression.kind) {
    case 'query':
      return expression.scope === undefined ? [] : frameSelectors(expression.scope);
    case 'filter':
    case 'index':
      return frameSelectors(expression.source);
    case 'web-selector':
      return [];
    case 'frame':
      return [expression.selector, ...frameSelectors(expression.source)];
  }
}
