/**
 * Key names the harness speaks (`Enter`, `Escape`, `ArrowDown`, `Meta+Shift+k`,
 * the Playwright vocabulary) onto the names Cua Driver's `press_key` and
 * `hotkey` take (`return`, `escape`, `down`, `["cmd", "shift", "k"]`).
 */

import { unsupported } from './support.ts';

export interface DriverKey {
  /** The non-modifier key, in Cua Driver's spelling. */
  readonly key: string;
  /** Modifiers in Cua Driver's spelling: `cmd`, `ctrl`, `option`, `shift`, `fn`. */
  readonly modifiers: readonly string[];
}

const MODIFIERS: Readonly<Record<string, string>> = {
  meta: 'cmd',
  command: 'cmd',
  cmd: 'cmd',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'option',
  option: 'option',
  shift: 'shift',
  fn: 'fn',
};

const KEYS: Readonly<Record<string, string>> = {
  enter: 'return',
  return: 'return',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  backspace: 'delete',
  delete: 'forwarddelete',
  space: 'space',
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

/**
 * Parses one harness key expression. `Meta+Shift+k` is a chord; a single
 * character is itself; a named key is translated; anything else is not a key
 * this surface can press.
 */
export function parseKey(expression: string): DriverKey {
  const parts = expression === '+' || expression === ' ' ? [expression] : expression.split('+').map((part) => part.trim());
  const modifiers: string[] = [];
  let key: string | undefined;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier !== undefined && parts.length > 1) {
      modifiers.push(modifier);
      continue;
    }
    if (key !== undefined) throw unsupported(`cannot press "${expression}": a chord has exactly one non-modifier key`);
    key = translateKey(part, expression);
  }
  if (key === undefined) throw unsupported(`cannot press "${expression}": no key to press`);
  return { key, modifiers };
}

function translateKey(part: string, expression: string): string {
  const named = KEYS[part.toLowerCase()];
  if (named !== undefined) return named;
  if ([...part].length === 1) return part.toLowerCase();
  if (/^f([1-9]|1[0-2])$/i.test(part)) return part.toLowerCase();
  throw unsupported(`cannot press "${expression}": Cua Driver has no key named "${part}"`);
}
