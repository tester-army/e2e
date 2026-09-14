/** The harness-side check of a `press` key against the contract's key grammar. */

import { KEY_MODIFIERS, KEY_NAMES, parseKey } from '../engine/contract.ts';
import { TestError } from './errors.ts';

/** Throws `INVALID_ARGUMENT` for anything but a key in the grammar `parseKey` accepts. */
export function requireKey(key: unknown): asserts key is string {
  if (typeof key === 'string' && parseKey(key) !== undefined) return;
  throw new TestError(
    'INVALID_ARGUMENT',
    `press key ${JSON.stringify(key)} is not a key: use zero or more modifiers (${KEY_MODIFIERS.join(', ')}) ` +
      `and one key joined by "+", where the key is a single character or one of ${KEY_NAMES.join(', ')} ` +
      '(for example "Enter", "Control+a", "Shift+Tab")',
  );
}
