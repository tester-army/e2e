/** LocatorExpression -> Playwright locator projection. */

import type { FrameLocator, Locator as PwLocator, Page } from 'playwright';
import { BackendError, type LocatorExpression, type SemanticQuery, type TextPattern } from '@e2edev/e2e/backend';

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
        throw new BackendError('BACKEND_FAILURE', 'role query value must be a string', {
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
      // Candidate set; the surface filters by current value at locate time.
      return scope.locator('input, textarea, select');
    case 'testId':
      return scope.getByTestId(patternToPw(query.value));
  }
}

/** One positional step applied after display-value filtering. */
export type PositionalStep = 'first' | 'last' | number;

export interface ProjectedLocator {
  /**
   * The Playwright locator to resolve. For a display-value query this is the
   * candidate set (every form control in scope), not the matches: Playwright
   * has no selector for a control's current value, so the value predicate can
   * only run after the candidates are read.
   */
  readonly locator: PwLocator;
  /** Non-null when the terminal query filters by display value. */
  readonly displayValue: TextPattern | null;
  /**
   * Positional selection (`first`, `last`, `nth`) to apply to the value-filtered
   * matches, innermost first. Always empty when `displayValue` is null, because
   * the projection then composes positions natively onto the locator.
   */
  readonly positions: readonly PositionalStep[];
}

const DISPLAY_VALUE_COMPOSITION_MESSAGE =
  'displayValue queries cannot scope child queries or serve as a has-filter in this backend';

/**
 * Projects a complete immutable expression onto a Playwright locator within
 * one scope. Frame cardinality is validated separately by the surface.
 *
 * A display-value query resolves to a candidate locator plus a value predicate
 * the surface applies once the candidates are read. Per-element filters
 * (`filter({ hasText, has })`) commute with that predicate, so they compose
 * onto the candidate locator as for any other query. Positional selection does
 * not commute (positions are relative to the value-filtered matches), so it is
 * recorded in `positions` and applied after filtering. Two compositions need
 * the predicate inside Playwright's own chain and stay unsupported: a
 * display-value query as the scope of a child query, and as a `has` filter.
 */
function project(scope: PwScope, expression: LocatorExpression): ProjectedLocator {
  switch (expression.kind) {
    case 'query': {
      const inner =
        expression.scope === undefined ? scope : requireComposable(project(scope, expression.scope));
      return {
        locator: queryToPw(inner, expression.query),
        displayValue: expression.query.kind === 'displayValue' ? expression.query.value : null,
        positions: [],
      };
    }
    case 'filter': {
      const source = project(scope, expression.source);
      if (source.positions.length > 0) {
        // A filter after first()/last()/nth() on value-filtered matches would
        // need the per-element check to run on the selected match alone, which
        // the candidate locator cannot express. Ask for the filter first.
        throw new BackendError(
          'UNSUPPORTED_CAPABILITY',
          'displayValue queries must apply filter() before first(), last(), or nth() in this backend',
          { retryable: false },
        );
      }
      const options: Parameters<PwLocator['filter']>[0] = {};
      if (expression.hasText !== undefined) options.hasText = patternToPw(expression.hasText);
      if (expression.has !== undefined) {
        options.has = requireComposable(project(scope, expression.has));
      }
      return { locator: source.locator.filter(options), displayValue: source.displayValue, positions: [] };
    }
    case 'index': {
      const source = project(scope, expression.source);
      if (source.displayValue !== null) {
        return { ...source, positions: [...source.positions, expression.index] };
      }
      const locator =
        expression.index === 'first'
          ? source.locator.first()
          : expression.index === 'last'
            ? source.locator.last()
            : source.locator.nth(expression.index);
      return { locator, displayValue: null, positions: [] };
    }
    case 'selector':
      return { locator: scope.locator(expression.selector), displayValue: null, positions: [] };
    case 'frame':
      return project(scope.frameLocator(expression.selector), expression.source);
  }
}

/** Projects an expression onto the page. */
export function projectExpression(page: Page, expression: LocatorExpression): ProjectedLocator {
  return project(page, expression);
}

/**
 * Returns the locator of a projection that must participate in Playwright's
 * own locator chain: a scope for child queries or a `has` target. A
 * display-value projection cannot, because its value predicate lives outside
 * that chain.
 */
function requireComposable(projected: ProjectedLocator): PwLocator {
  if (projected.displayValue !== null) {
    throw new BackendError('UNSUPPORTED_CAPABILITY', DISPLAY_VALUE_COMPOSITION_MESSAGE, {
      retryable: false,
    });
  }
  return projected.locator;
}

/**
 * Applies positional steps, innermost first, to an ordered list of matches.
 * `nth` past the end selects nothing, matching Playwright's `nth` on a
 * locator with too few matches.
 */
export function selectPositions<T>(matches: readonly T[], positions: readonly PositionalStep[]): readonly T[] {
  let selected = matches;
  for (const position of positions) {
    if (position === 'first') selected = selected.slice(0, 1);
    else if (position === 'last') selected = selected.slice(-1);
    else selected = position < selected.length ? [selected[position]!] : [];
  }
  return selected;
}

/** Returns every frame selector along an expression, outermost first. */
export function frameSelectors(expression: LocatorExpression): string[] {
  switch (expression.kind) {
    case 'query':
      return expression.scope === undefined ? [] : frameSelectors(expression.scope);
    case 'filter':
    case 'index':
      return frameSelectors(expression.source);
    case 'selector':
      return [];
    case 'frame':
      return [expression.selector, ...frameSelectors(expression.source)];
  }
}
