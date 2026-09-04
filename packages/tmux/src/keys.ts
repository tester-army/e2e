/**
 * Key names onto tmux `send-keys` arguments. The contract's `press` action
 * and the agent's `press` verb speak the browser vocabulary (`Enter`,
 * `Escape`, `ArrowDown`, `Control+C`); tmux speaks its own (`Enter`,
 * `Escape`, `Down`, `C-c`). Both are accepted, so a test author can write
 * whichever they think in, and a native tmux chord passes through untouched.
 */

import { unsupported } from './support.ts';

const NAMED: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'BSpace',
  bspace: 'BSpace',
  delete: 'DC',
  del: 'DC',
  dc: 'DC',
  insert: 'IC',
  ic: 'IC',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PPage',
  ppage: 'PPage',
  pgup: 'PPage',
  pagedown: 'NPage',
  npage: 'NPage',
  pgdn: 'NPage',
  space: 'Space',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

const MODIFIERS: Readonly<Record<string, 'C' | 'M' | 'S'>> = {
  control: 'C',
  ctrl: 'C',
  c: 'C',
  alt: 'M',
  option: 'M',
  meta: 'M',
  m: 'M',
  shift: 'S',
  s: 'S',
};

/** A chord already spelled the tmux way (`C-c`, `M-x`, `C-M-Left`). */
const TMUX_CHORD = /^(?:[CMS]-)+\S+$/;

/**
 * The `send-keys` arguments for one key: `['-l', '--', 'x']` for a plain
 * character (sent literally, so `;` and `-` are text and not tmux syntax),
 * `['Enter']` or `['C-c']` for a named key or chord.
 */
export function keyArgs(key: string): string[] {
  const trimmed = key.trim();
  if (trimmed === '') throw unsupported('cannot press an empty key');
  if (TMUX_CHORD.test(trimmed)) return [trimmed];
  const parts = splitChord(trimmed);
  const base = parts.at(-1) as string;
  const modifiers = new Set(
    parts.slice(0, -1).map((part) => {
      const modifier = MODIFIERS[part.toLowerCase()];
      if (modifier === undefined) throw unsupported(`unknown key modifier "${part}" in "${key}"`);
      return modifier;
    }),
  );
  const prefix = (['C', 'M', 'S'] as const).filter((modifier) => modifiers.has(modifier)).map((modifier) => `${modifier}-`).join('');
  if ([...base].length === 1) {
    if (prefix === '') return ['-l', '--', base];
    if (prefix === 'S-') return ['-l', '--', base.toUpperCase()];
    return [`${prefix.replace('S-', '')}${modifiers.has('S') ? base.toUpperCase() : base.toLowerCase()}`];
  }
  const named = NAMED[base.toLowerCase()];
  if (named === undefined) throw unsupported(`unknown key "${key}"; use a browser key name (Enter, Escape, ArrowDown, Control+C) or a tmux chord (C-c)`);
  if (named === 'Tab' && prefix === 'S-') return ['BTab'];
  return [`${prefix}${named}`];
}

/** Splits `Control+Shift+x` into its parts; a trailing `+` is the plus key itself. */
function splitChord(chord: string): string[] {
  if (!chord.includes('+') || chord.length === 1) return [chord];
  const parts = chord.split('+');
  const trailingEmpty = parts.length > 1 && parts.at(-1) === '';
  const filtered = parts.filter((part) => part !== '');
  return trailingEmpty ? [...filtered, '+'] : filtered;
}
