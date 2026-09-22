/** LocatorExpression -> Playwright locator projection. */

import type { FrameLocator, Locator as PwLocator, Page } from 'playwright';
import { EngineError, type LocatorExpression, type SemanticQuery, type TextPattern } from 'e2e/engine';

type PwScope = Page | FrameLocator | PwLocator;

function patternToPw(pattern: TextPattern): string | RegExp {
  if (pattern.kind === 'regexp') return new RegExp(pattern.source, pattern.flags);
  return pattern.value;
}

function patternExact(pattern: TextPattern): boolean {
  return pattern.kind === 'string' ? pattern.exact : false;
}

/**
 * The selector `getByTestId` compiles to, with the project's attribute in
 * place of Playwright's process-global one (`selectors.setTestIdAttribute`
 * would leak one engine's attribute into every other engine of the process).
 * The value is encoded as Playwright's `escapeForAttributeSelector` encodes it:
 * a string is an exact, case-sensitive match; a RegExp is passed as written.
 */
function testIdSelector(attribute: string, pattern: TextPattern): string {
  const name = attribute.includes(',') ? JSON.stringify(attribute) : attribute;
  const value =
    pattern.kind === 'regexp'
      ? escapeRegexForSelector(new RegExp(pattern.source, pattern.flags))
      : `"${pattern.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"s`;
  return `internal:testid=[${name}=${value}]`;
}

/** A RegExp written into a Playwright selector: quotes and `>>` escaped unless the flags forbid it. */
function escapeRegexForSelector(re: RegExp): string {
  if (/[uv]/.test(re.flags)) return String(re);
  return String(re)
    .replace(/(^|[^\\])(\\\\)*(["'`])/g, '$1$2\\$3')
    .replace(/>>/g, '\\>\\>');
}

/**
 * The contract's role vocabulary spelled as the ARIA role the role selector
 * knows, where the two differ: the tree reports an `img` as `image`, so an
 * `image` query has to go back to `img` to match it.
 */
const ARIA_ROLE_BY_CONTRACT_ROLE: Readonly<Record<string, string>> = { image: 'img' };

function queryToPw(scope: PwScope, query: SemanticQuery, testIdAttribute: string): PwLocator {
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new EngineError('ENGINE_FAILURE', 'role query value must be a string', {
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
      if (states.pressed !== undefined) options.pressed = states.pressed;
      if (query.level !== undefined) options.level = query.level;
      const role = ARIA_ROLE_BY_CONTRACT_ROLE[query.value.value] ?? query.value.value;
      return scope.getByRole(role as Parameters<Page['getByRole']>[0], options);
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
      return scope.locator(testIdSelector(testIdAttribute, query.value));
  }
}

/** One positional step applied after display-value filtering. */
export type PositionalStep = 'first' | 'last' | number;

type PwFilterOptions = NonNullable<Parameters<PwLocator['filter']>[0]>;

/**
 * One step a display-value projection applies after its candidates are
 * value-filtered, in expression order: a position among the matches, or a
 * per-element filter that came after a position and so could not compose onto
 * the candidate locator.
 */
export type PostStep =
  | { readonly kind: 'index'; readonly index: PositionalStep }
  | { readonly kind: 'filter'; readonly options: PwFilterOptions };

/**
 * Self-selector for the part of the semantic `hidden` state Playwright's own
 * visibility filter does not read: `aria-hidden="true"` on the element or an
 * ancestor. XPath because Playwright's CSS `:not()` takes no descendant
 * selector. `ancestor-or-self` stops at a shadow root, so this narrowing is
 * an approximation where a visible query composes as a scope or `has`
 * filter; a terminal query, positioned or not, is read whole and its
 * predicate crosses the host.
 */
const NOT_ARIA_HIDDEN = 'xpath=self::*[not(ancestor-or-self::*[@aria-hidden="true"])]';

/**
 * A `visible` query narrows its candidates inside the selector, before any
 * enclosing scope, filter, or index runs: Playwright's visibility predicate
 * (layout box, `display`, `visibility`) plus the `aria-hidden` check the
 * semantic `hidden` state also makes. An indexed, filtered, or scoping visible
 * query therefore never selects or retains a node that state calls hidden.
 * The surface additionally holds a terminal query to the batch-read `hidden`
 * state, so a direct query agrees with `toBeVisible()` even at the margin
 * where the two predicates differ (a zero-size element with a layout rect is
 * hidden to Playwright and shown to the semantic read).
 */
function visibleQueryToPw(scope: PwScope, query: SemanticQuery, testIdAttribute: string): PwLocator {
  const located = queryToPw(scope, query, testIdAttribute);
  if (query.visible !== true) return located;
  return located.filter({ visible: true }).locator(NOT_ARIA_HIDDEN);
}

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
   * Non-null when the terminal query is an exact label query: `locator` holds
   * every labelable control in scope and the surface keeps those with an
   * associated label (an `aria-label`, an `aria-labelledby` target, or a
   * `<label>`) whose accessible-name text equals the pattern. Playwright's own
   * `getByLabel` reads a label's full text, aria-hidden included, so a
   * required-field marker made `getByLabel('Display name')` miss
   * `Display name*`; the engine's reader drops such text.
   */
  readonly name: TextPattern | null;
  /**
   * The Playwright locator to compose with as a scope or `has` filter, for a
   * projection whose own predicate lives outside Playwright's chain. An exact
   * label query composes through Playwright's substring label match, which
   * accepts every control the predicate would and some it would not; a
   * positioned visible query composes through its selector-level narrowing,
   * which reads `aria-hidden` up to the nearest shadow root. Those are the two
   * places the predicate is approximated. Null for a display-value
   * projection, which has no such equivalent and is rejected instead.
   */
  readonly composable: PwLocator | null;
  /**
   * Steps to apply to the predicate-filtered matches, innermost first. Empty
   * for a projection with no display-value predicate, no exact-label
   * predicate, and no `visible` flag, which composes positions and filters
   * natively onto the locator.
   */
  readonly steps: readonly PostStep[];
  /**
   * True when the terminal query keeps only nodes whose `hidden` state is
   * false. The surface applies it to the batch read before the display-value
   * predicate and any post step, so a position is taken among shown matches.
   */
  readonly visible: boolean;
}

/**
 * Every control `getByLabel` can name: labelable form controls plus anything
 * carrying its own label attributes. The candidates of an exact label query;
 * the surface keeps those whose labels match.
 */
const LABELABLE_SELECTOR =
  'button, input:not([type="hidden"]), textarea, select, meter, output, progress, [aria-label], [aria-labelledby]';

function positioned(locator: PwLocator, index: 'first' | 'last' | number): PwLocator {
  return index === 'first' ? locator.first() : index === 'last' ? locator.last() : locator.nth(index);
}

const DISPLAY_VALUE_COMPOSITION_MESSAGE =
  'displayValue queries cannot scope child queries or serve as a has-filter in this engine';

/**
 * Projects a complete immutable expression onto a Playwright locator within
 * one scope. Frame cardinality is validated separately by the surface.
 *
 * A display-value query resolves to a candidate locator plus a value predicate
 * the surface applies once the candidates are read. Per-element filters
 * (`filter({ hasText, has })`) commute with that predicate, so they compose
 * onto the candidate locator as for any other query. Positional selection does
 * not commute (positions are relative to the value-filtered matches), so it is
 * recorded as a step and applied after filtering; a filter that follows a
 * position is recorded the same way and checked on the selected element. Two
 * compositions need the predicate inside Playwright's own chain and stay
 * unsupported: a display-value query as the scope of a child query, and as a
 * `has` filter.
 */
function project(scope: PwScope, expression: LocatorExpression, testIdAttribute: string): ProjectedLocator {
  switch (expression.kind) {
    case 'query': {
      const inner =
        expression.scope === undefined
          ? scope
          : requireComposable(project(scope, expression.scope, testIdAttribute));
      const { query } = expression;
      const exactLabel = query.kind === 'label' && patternExact(query.value);
      const locator = exactLabel
        ? inner.locator(LABELABLE_SELECTOR)
        : visibleQueryToPw(inner, query, testIdAttribute);
      return {
        locator,
        displayValue: query.kind === 'displayValue' ? query.value : null,
        name: exactLabel ? query.value : null,
        composable: exactLabel ? inner.getByLabel(patternToPw(query.value), { exact: false }) : null,
        steps: [],
        visible: query.visible === true,
      };
    }
    case 'filter': {
      const source = project(scope, expression.source, testIdAttribute);
      const options: PwFilterOptions = {};
      if (expression.hasText !== undefined) options.hasText = patternToPw(expression.hasText);
      if (expression.has !== undefined) {
        options.has = requireComposable(project(scope, expression.has, testIdAttribute));
      }
      if (source.steps.length > 0) {
        return { ...source, steps: [...source.steps, { kind: 'filter', options }] };
      }
      return {
        ...source,
        locator: source.locator.filter(options),
        composable: source.composable === null ? null : source.composable.filter(options),
        steps: [],
      };
    }
    case 'index': {
      const source = project(scope, expression.source, testIdAttribute);
      if (source.displayValue !== null || source.name !== null || source.visible) {
        // A position on a visible query is taken among the nodes the full
        // hidden predicate keeps, after the batch read: the selector-level
        // narrowing misses a match inside an aria-hidden host's shadow tree,
        // and `first()` on such a page must be the first shown node.
        const composable =
          source.composable !== null
            ? positioned(source.composable, expression.index)
            : source.displayValue === null
              ? positioned(source.locator, expression.index)
              : null;
        return {
          ...source,
          composable,
          steps: [...source.steps, { kind: 'index', index: expression.index }],
        };
      }
      return {
        locator: positioned(source.locator, expression.index),
        displayValue: null,
        name: null,
        composable: null,
        steps: [],
        visible: false,
      };
    }
    case 'selector':
      return {
        locator: scope.locator(expression.selector),
        displayValue: null,
        name: null,
        composable: null,
        steps: [],
        visible: false,
      };
    case 'frame':
      return project(scope.frameLocator(expression.selector), expression.source, testIdAttribute);
  }
}

/** Projects an expression onto the page; `testIdAttribute` is what a `testId` query reads. */
export function projectExpression(
  page: Page,
  expression: LocatorExpression,
  testIdAttribute: string,
): ProjectedLocator {
  return project(page, expression, testIdAttribute);
}

/**
 * Returns the locator of a projection that must participate in Playwright's
 * own locator chain: a scope for child queries or a `has` target. A
 * display-value projection cannot, because its value predicate lives outside
 * that chain.
 */
function requireComposable(projected: ProjectedLocator): PwLocator {
  if (projected.composable !== null) return projected.composable;
  if (projected.displayValue !== null) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', DISPLAY_VALUE_COMPOSITION_MESSAGE, {
      retryable: false,
    });
  }
  return projected.locator;
}

/**
 * Applies post steps, innermost first, to an ordered list of matches. `nth`
 * past the end selects nothing, matching Playwright's `nth` on a locator with
 * too few matches. A filter step keeps the matches `passesFilter` accepts;
 * it runs only on the matches that survived the steps before it.
 */
export async function applyPostSteps<T>(
  matches: readonly T[],
  steps: readonly PostStep[],
  passesFilter: (match: T, options: PwFilterOptions) => Promise<boolean>,
): Promise<readonly T[]> {
  let selected = matches;
  for (const step of steps) {
    if (step.kind === 'index') {
      const { index } = step;
      if (index === 'first') selected = selected.slice(0, 1);
      else if (index === 'last') selected = selected.slice(-1);
      else selected = index < selected.length ? [selected[index]!] : [];
      continue;
    }
    const kept: T[] = [];
    for (const match of selected) {
      if (await passesFilter(match, step.options)) kept.push(match);
    }
    selected = kept;
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
