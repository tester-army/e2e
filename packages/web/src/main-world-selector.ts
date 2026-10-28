/**
 * A captured-native secure-field query in the main world. WebKit can lose a utility
 * context after a JavaScript-URL frame rewrites its document while its main
 * context remains usable. Match Playwright's fixed CSS predicate and exact
 * light/open-shadow traversal without calling page-overridden DOM methods.
 */

import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import { SECURE_FIELD_SELECTOR } from './read-node.ts';

export const MAIN_WORLD_SELECTOR_ENGINE = 'e2e-secure';

/** The single native secure predicate and DOM checks run in one synchronous query. */
export const MAIN_WORLD_SELECTOR_ENGINE_SOURCE = `() => {
  const record = globalThis[Symbol.for(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)})];
  const queryAll = (root, body) => {
    if (body !== ${JSON.stringify(SECURE_FIELD_SELECTOR)}) throw new Error('the secure-field selector only accepts the native secure predicate');
    if (!(record instanceof WeakMap) || record.maskDOMVersion !== 1 || typeof record.querySecureFields !== 'function')
      throw new Error('secure-field DOM integrity is unavailable for this document');
    return record.querySecureFields(root);
  };
  return { queryAll, query: (root, body) => queryAll(root, body)[0] ?? null };
}`;
