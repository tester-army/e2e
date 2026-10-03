/** LocatorExpression -> Playwright locator projection. */

import type { FrameLocator, Locator as PwLocator, Page } from 'playwright';
import { EngineError, type LocatorExpression, type SemanticQuery, type TextPattern } from 'e2e/engine';
import { SEARCH_ROOTS_SELECTOR_ENGINE } from './closed-shadow.ts';
import { exactLabelSelector } from './label-selector.ts';
import { SECURE_FIELD_SELECTOR } from './read-node.ts';
import { SHOWN_SELECTOR } from './shown-selector.ts';

type PwScope = Page | FrameLocator | PwLocator;

function patternToPw(pattern: TextPattern): string | RegExp {
  if (pattern.kind === 'regexp') return selectorSafeRegExp(new RegExp(pattern.source, pattern.flags));
  return pattern.value;
}

/**
 * A RegExp Playwright can write into a selector as is. Playwright escapes the
 * quotes and `>>` of a RegExp it writes into a selector, except under the `u`
 * or `v` flag, where `\'` is a syntax error: a bare quote there opens a
 * string that swallows every part chained after it. A quote or the second `>`
 * of `>>` becomes the hex escape the flag accepts, matching the same text.
 */
function selectorSafeRegExp(re: RegExp): RegExp {
  if (!/[uv]/.test(re.flags)) return re;
  const source = re.source
    .replace(/["'`]/g, (quote) => `\\x${quote.charCodeAt(0).toString(16)}`)
    .replace(/>>/g, '>\\x3e');
  return source === re.source ? re : new RegExp(source, re.flags);
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
      ? escapeRegexForSelector(selectorSafeRegExp(new RegExp(pattern.source, pattern.flags)))
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

/**
 * Every control that displays a current value: the candidates of a
 * display-value query. A checkbox or radio carries a value it never shows
 * (`on` by default), so it is no candidate.
 */
const VALUED_SELECTOR = 'input:not([type="checkbox" i]):not([type="radio" i]), textarea, select';

/**
 * How one query kind reaches its nodes across the roots it searches: its
 * scope, then every closed shadow root recorded under it. A Playwright getter
 * is composed onto those roots (`e2e-roots=`), so the platform's own role,
 * name, text, label, and attribute matching runs in each of them. A CSS
 * candidate set is matched per root by the engine itself (`e2e-roots=<css>`)
 * and narrowed by a predicate the surface applies once the candidates are
 * read: a control's current value. The engine matches the CSS itself rather
 * than composing it onto the roots because Playwright's CSS engine sorts a
 * list's matches in DOM order through `shadowRoot`, which a closed root does
 * not expose, and drops the ones it cannot place. An `engine` selector names
 * one of ours that searches the scope and its closed roots on its own.
 */
type Candidates =
  | { readonly kind: 'playwright'; readonly locate: (roots: PwLocator) => PwLocator }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'engine'; readonly selector: string };

/** Whitespace or an icon-font glyph (a private-use code point), the characters the tree's names drop or collapse. */
const GLYPH_OR_SPACE = '[\\s\\p{Co}]';

/**
 * A role query's string name as a pattern for the name the browser
 * computes, which keeps the private-use glyphs of an icon font the tree
 * drops (`in-page/read-semantics.ts`): "Login" matches the browser's
 * "\uf090 Login", the button a person reads as Login. A glyph may stand
 * wherever the name has a space or begins or ends. Exact is whole and
 * case-sensitive, else a case-insensitive substring, as Playwright matches a
 * string name.
 */
function glyphTolerantName(name: string, exact: boolean): RegExp {
  const body = name
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join(`${GLYPH_OR_SPACE}+`);
  return selectorSafeRegExp(exact ? new RegExp(`^${GLYPH_OR_SPACE}*${body}${GLYPH_OR_SPACE}*$`, 'u') : new RegExp(body, 'iu'));
}

/**
 * The one table of query kinds: each declares its Playwright getter or its
 * CSS candidate set. An exact label query is the one kind whose candidates
 * depend on the pattern: exact goes to the `e2e-label` engine, substring
 * stays with Playwright's `getByLabel`.
 */
function candidatesOf(query: SemanticQuery, testIdAttribute: string): Candidates {
  switch (query.kind) {
    case 'role': {
      if (query.value.kind !== 'string') {
        throw new EngineError('ENGINE_FAILURE', 'role query value must be a string', {
          retryable: false,
        });
      }
      const options: Parameters<Page['getByRole']>[1] = {};
      const states = query.states ?? {};
      if (states.checked !== undefined) options.checked = states.checked;
      if (states.disabled !== undefined) options.disabled = states.disabled;
      if (states.selected !== undefined) options.selected = states.selected;
      if (states.expanded !== undefined) options.expanded = states.expanded;
      if (states.pressed !== undefined) options.pressed = states.pressed;
      if (query.level !== undefined) options.level = query.level;
      const role = (ARIA_ROLE_BY_CONTRACT_ROLE[query.value.value] ?? query.value.value) as Parameters<Page['getByRole']>[0];
      const name = query.name;
      if (name === undefined) return { kind: 'playwright', locate: (roots) => roots.getByRole(role, options) };
      if (name.kind === 'regexp') return { kind: 'playwright', locate: (roots) => roots.getByRole(role, { ...options, name: patternToPw(name) }) };
      return { kind: 'playwright', locate: (roots) => roots.getByRole(role, { ...options, name: glyphTolerantName(name.value, name.exact) }) };
    }
    case 'label':
      return query.value.kind === 'string' && query.value.exact
        ? {
            kind: 'engine',
            selector: exactLabelSelector({ value: query.value.value, testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR }),
          }
        : { kind: 'playwright', locate: (roots) => roots.getByLabel(patternToPw(query.value), { exact: false }) };
    case 'placeholder':
      return { kind: 'playwright', locate: (roots) => roots.getByPlaceholder(patternToPw(query.value), { exact: patternExact(query.value) }) };
    case 'text':
      return { kind: 'playwright', locate: (roots) => roots.getByText(patternToPw(query.value), { exact: patternExact(query.value) }) };
    case 'displayValue':
      return { kind: 'css', selector: VALUED_SELECTOR };
    case 'testId':
      return { kind: 'playwright', locate: (roots) => roots.locator(testIdSelector(testIdAttribute, query.value)) };
  }
}

/** Composes the candidates of one query onto `scope` and the closed shadow roots under it. */
function queryToPw(scope: PwScope, query: SemanticQuery, testIdAttribute: string): PwLocator {
  const candidates = candidatesOf(query, testIdAttribute);
  switch (candidates.kind) {
    case 'css':
      return scope.locator(`${SEARCH_ROOTS_SELECTOR_ENGINE}=${candidates.selector}`);
    case 'engine':
      return scope.locator(candidates.selector);
    case 'playwright':
      return candidates.locate(scope.locator(`${SEARCH_ROOTS_SELECTOR_ENGINE}=`));
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
 * A `visible` query narrows its candidates inside the selector, before any
 * enclosing scope, filter, or index runs, by the reader's own `hidden` state
 * (`e2e-shown`). An indexed, filtered, or scoping visible query therefore
 * never selects or retains a node that state calls hidden, and the surface's
 * hold of a terminal query to the batch-read state agrees with it.
 */
function visibleQueryToPw(scope: PwScope, query: SemanticQuery, testIdAttribute: string): PwLocator {
  return narrowedToVisible(queryToPw(scope, query, testIdAttribute), query);
}

/** The visibility narrowing above, on a locator already built for `query`; identity unless the query is `visible`. */
function narrowedToVisible(located: PwLocator, query: SemanticQuery): PwLocator {
  if (query.visible !== true) return located;
  return located.locator(SHOWN_SELECTOR);
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
   * the controls the `e2e-label` engine found labelled with the pattern, and
   * the surface reads them and keeps those still labelled with it: an
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
   * label query composes as its `locator`, whose `e2e-label` engine runs the
   * reader's label predicate inside the page, so a `has` filter keeps the row
   * the label names and no row whose label merely contains it.
   * Null for a display-value projection, which has no such equivalent and is
   * rejected instead.
   */
  readonly composable: PwLocator | null;
  /**
   * Steps to apply to the value-filtered matches, innermost first. Always
   * empty when `displayValue` is null, because the projection then composes
   * positions and filters natively onto the locator.
   */
  readonly steps: readonly PostStep[];
  /**
   * True when the terminal query keeps only nodes whose `hidden` state is
   * false. The surface applies it to the batch read before the display-value
   * predicate and any post step, so a position is taken among shown matches.
   */
  readonly visible: boolean;
}

function positioned(locator: PwLocator, index: 'first' | 'last' | number): PwLocator {
  return index === 'first' ? locator.first() : index === 'last' ? locator.last() : locator.nth(index);
}

const DISPLAY_VALUE_COMPOSITION_MESSAGE =
  'displayValue queries cannot scope child queries or serve as a has-filter in this engine';

/**
 * Projects a complete immutable expression onto a Playwright locator within
 * one scope. Frame cardinality is validated separately by the surface.
 *
 * Every semantic query searches its scope and the closed shadow roots under
 * it (see `Candidates`), so a scope, a `has` filter, and an index reach
 * across a closed boundary. Two compositions stay Playwright's own and stop
 * at one: a `selector` expression is the platform's CSS or XPath, and
 * `filter({ hasText })` reads an element's text as Playwright does, light DOM
 * and open roots, so text inside a closed root does not count toward an
 * element outside it.
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
      const exactLabel = query.kind === 'label' && query.value.kind === 'string' && query.value.exact ? query.value : null;
      const locator = visibleQueryToPw(inner, query, testIdAttribute);
      return {
        locator,
        displayValue: query.kind === 'displayValue' ? query.value : null,
        name: exactLabel,
        composable: exactLabel === null ? null : locator,
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
      if (source.displayValue !== null || source.name !== null) {
        return {
          ...source,
          composable: source.composable === null ? null : positioned(source.composable, expression.index),
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
