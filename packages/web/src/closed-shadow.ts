/**
 * Closed shadow roots, kept reachable for the reader, the locators, and the
 * screenshot masks: the context init script that records them, and the two
 * Playwright selector engines that search them. Both engines are page code as
 * source strings; the engine list is what the browser connection and the CDP
 * context register.
 */

/**
 * Where the init script below records closed shadow roots, keyed by host, and
 * where the in-page reader looks for them. The reader is serialized into the
 * page and cannot import this constant, so the literal is repeated inside it;
 * the two must agree, like `SECURE_FIELD_SELECTOR` on both sides of masking.
 *
 * The record is a `WeakMap` from host to root with one own property beside
 * the map: `count`, the number of closed roots the document has attached. It
 * lets a selector engine answer for a document without closed roots without
 * walking it.
 */
export const CLOSED_SHADOW_ROOTS_KEY = 'e2e.closedShadowRoots';

/**
 * Context init script that keeps every closed shadow root reachable for the
 * reader. A closed root hides its tree from `element.shadowRoot`, so a checkout
 * button a third-party widget renders that way is on screen for a person yet
 * absent from the walk. `attachShadow` is the one way a script creates such a
 * root; wrapping it before any page script runs records host and root in a
 * WeakMap under a well-known symbol, which the reader consults where it reads
 * `shadowRoot`, and counts the roots attached so far. The map is keyed by the
 * host element and never enumerated, so it holds nothing alive and changes
 * nothing the page can observe about the root itself. Declarative
 * `<template shadowrootmode="closed">` roots are parsed rather than attached
 * and stay out of reach.
 */
export const CLOSED_SHADOW_ROOTS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  const roots = new WeakMap();
  Object.defineProperty(roots, 'count', { value: 0, enumerable: false, configurable: false, writable: true });
  Object.defineProperty(globalThis, key, { value: roots, enumerable: false, configurable: false, writable: false });
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    if (root.mode === 'closed') {
      roots.set(this, root);
      roots.count += 1;
    }
    return root;
  };
})();`;

/** Playwright selector engine name; `e2e-closed=<css>` matches inside recorded closed shadow roots. */
export const CLOSED_SHADOW_SELECTOR_ENGINE = 'e2e-closed';

/**
 * Playwright selector engine name for the roots a semantic query searches.
 * `e2e-roots=` (an empty body) resolves to the query root followed by every
 * closed shadow root recorded under it, so the Playwright query part that
 * follows (`internal:role`, `internal:text`, `internal:label`, ...) runs its
 * own matching in each of them; `e2e-roots=<css>` resolves to the elements the
 * CSS selector matches in the query root and in every closed root under it.
 */
export const SEARCH_ROOTS_SELECTOR_ENGINE = 'e2e-roots';

/**
 * In-page helpers the selector engines below and the label engine
 * (`label-selector.ts`) are built on, as source: the
 * closed roots the init script recorded under a query root (the root's own,
 * when it is a closed host, and every one below through open and closed
 * roots alike), and the elements a CSS selector matches in one tree and the
 * open roots below it. A closed root is searched only as an entry of the
 * first list, never by recursion from the tree above it, so each element is
 * reached from exactly one root. A document that has attached no closed root
 * (the record's `count` is zero) has none to find, and the walk over every
 * element is skipped; every locator resolution runs this, so a page without
 * closed roots must pay nothing for the reach.
 */
export const CLOSED_SHADOW_HELPERS_SOURCE = `
  const roots = globalThis[Symbol.for(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)})];
  const tracked = roots instanceof WeakMap;
  const closedRootsUnder = (root, out) => {
    if (!tracked || roots.count === 0) return out;
    const scan = (el) => {
      const closed = roots.get(el);
      if (closed !== undefined) out.push(closed);
      const nested = el.shadowRoot ?? closed;
      if (nested !== undefined && nested !== null) closedRootsUnder(nested, out);
    };
    if (root.nodeType === 1) scan(root);
    for (const el of root.querySelectorAll('*')) scan(el);
    return out;
  };
  const matchesIn = (root, selector, out) => {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    if (root.nodeType === 1 && root.shadowRoot !== null) matchesIn(root.shadowRoot, selector, out);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot !== null) matchesIn(el.shadowRoot, selector, out);
    }
    return out;
  };`;

/**
 * The engine behind `e2e-closed=<css>`: every element matching the CSS
 * selector inside a closed shadow root the init script recorded, reached from
 * the query root through light DOM and open roots, and through roots of either
 * kind nested below a closed one. Playwright's own selectors stop at a closed
 * root, so this is what lets a screenshot mask cover a secure field the reader
 * now reports there. It runs in the page's main world (not as a content
 * script) because that is where the record lives. A document without the
 * record is refused: a mask that cannot prove its coverage must fail closed.
 */
const CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const queryAll = (root, selector) => {
    if (!tracked) throw new Error('closed-shadow root tracking is unavailable for this document');
    const out = [];
    for (const closed of closedRootsUnder(root, [])) matchesIn(closed, selector, out);
    return out;
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;

/**
 * The engine behind `e2e-roots=`: the roots a semantic query searches, or the
 * elements a CSS selector matches across them. Playwright's own query engines
 * accept a shadow root as their root and never cross a closed boundary
 * downward, so listing every closed root as a root of its own lets them match
 * inside with the same role, name, text, label, and attribute rules they apply
 * outside, and finds each element exactly once. A CSS selector list is matched
 * here rather than by Playwright's CSS engine, which sorts a list's matches in
 * DOM order through `shadowRoot` and so drops the direct children of a closed
 * root; the matches of one root keep their document order and roots follow in
 * the order they were found. A document without the record answers as
 * Playwright alone would, so a locator never fails where it used to work.
 */
const SEARCH_ROOTS_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const queryAll = (root, selector) => {
    if (selector === '') return [root, ...closedRootsUnder(root, [])];
    const out = matchesIn(root, selector, []);
    for (const closed of closedRootsUnder(root, [])) matchesIn(closed, selector, out);
    return out;
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;

/** The two closed-root selector engines; `selector-engines.ts` lists them with the label engine for registration. */
export const CLOSED_SHADOW_SELECTOR_ENGINES: readonly { readonly name: string; readonly source: string }[] = [
  { name: CLOSED_SHADOW_SELECTOR_ENGINE, source: CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE },
  { name: SEARCH_ROOTS_SELECTOR_ENGINE, source: SEARCH_ROOTS_SELECTOR_ENGINE_SOURCE },
];
