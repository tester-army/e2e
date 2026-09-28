/**
 * The selector engine an exact label query resolves through, standing alone
 * and inside Playwright's own chain (a scope for child queries, a `has`
 * filter) alike: it runs the reader on every labelable control under the
 * query root and keeps the ones labelled with the pattern, in the one task
 * that finds them. A control the page replaces a frame later is then no
 * candidate of a query for another label and cannot make it re-resolve.
 * Playwright's `getByLabel` could not stand in for it: its exact form reads a
 * label's aria-hidden text and misses `Display name*`, and its substring form
 * accepts `Last Name` for `Name`.
 */

import { CLOSED_SHADOW_HELPERS_SOURCE } from './closed-shadow.ts';
import { readSemanticsFunction } from './in-page/read-semantics.ts';

/** Playwright selector engine name; `e2e-label=<json>` matches the controls one exact label names. */
export const EXACT_LABEL_SELECTOR_ENGINE = 'e2e-label';

/**
 * Every control `getByLabel` can name: labelable form controls plus anything
 * carrying its own label attributes. The candidates of an exact label query;
 * the engine below keeps those whose labels match.
 */
const LABELABLE_SELECTOR =
  'button, input:not([type="hidden"]), textarea, select, meter, output, progress, [aria-label], [aria-labelledby]';

/** What the selector body carries into the page: the label to equal and the reader's options. */
export interface ExactLabelSelectorBody {
  readonly value: string;
  readonly testIdAttribute: string;
  readonly secureFieldSelector: string;
}

/**
 * The selector for the controls whose label reads exactly `body.value`. The
 * body is JSON: Playwright's selector parser keeps a quoted region whole, so
 * the quotes and `>>` a label may contain travel inside the JSON strings.
 */
export function exactLabelSelector(body: ExactLabelSelectorBody): string {
  return `${EXACT_LABEL_SELECTOR_ENGINE}=${JSON.stringify(body)}`;
}

/**
 * The engine behind `e2e-label=<json>`: the labelable controls under the query
 * root, across the closed shadow roots recorded under it, whose labels as the
 * reader names them (`RawNodeData.labels`) include the body's value once both
 * are whitespace-normalized, the comparison the surface makes with
 * `matchesText` on an exact string pattern. Reading a node's semantics for
 * each candidate is what the standalone query pays too. The reader is embedded
 * as source because a selector engine, like the reader, is one self-contained
 * page function.
 */
export const EXACT_LABEL_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const read = (${readSemanticsFunction.toString()});
  const normalize = (text) => text.replace(/\\s+/gu, ' ').trim();
  const queryAll = (root, selector) => {
    const body = JSON.parse(selector);
    const expected = normalize(body.value);
    const options = { testIdAttribute: body.testIdAttribute, secureFieldSelector: body.secureFieldSelector, mode: { kind: 'node' } };
    const candidates = matchesIn(root, ${JSON.stringify(LABELABLE_SELECTOR)}, []);
    for (const closed of closedRootsUnder(root, [])) matchesIn(closed, ${JSON.stringify(LABELABLE_SELECTOR)}, candidates);
    return candidates.filter((el) => (read(el, options).labels ?? []).some((label) => normalize(label) === expected));
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;
