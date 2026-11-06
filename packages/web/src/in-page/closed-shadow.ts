/**
 * Closed shadow roots, kept reachable for the reader, the locators, and the
 * screenshot masks: the init script that records them.
 */

/**
 * Where the init script below records closed shadow roots, keyed by host, and
 * where the in-page reader looks for them. The reader is serialized into the
 * page and cannot import this constant, so the literal is repeated inside it;
 * the two must agree, like `SECURE_FIELD_SELECTOR` on both sides of masking.
 *
 * The record is a `WeakMap` from host to root with one own property beside
 * the map: `count`, the number of closed roots the document has attached. It
 * lets a reader answer for a document without closed roots without walking
 * it.
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
