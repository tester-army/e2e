/** The message for a `press` key outside the contract's key grammar. */

import { KEY_MODIFIERS, KEY_NAMES } from '../engine/contract.ts';

export function invalidKeyMessage(key: unknown): string {
  return (
    `press key ${JSON.stringify(key)} is not a key: use zero or more modifiers (${KEY_MODIFIERS.join(', ')}) ` +
    `and one key joined by "+", where the key is a single character or one of ${KEY_NAMES.join(', ')} ` +
    '(for example "Enter", "Control+a", "Shift+Tab")'
  );
}
