/**
 * The keyboard model of the BiDi driver: Playwright's US layout, one entry
 * per key `code` with the WebDriver key value of each key, and the two key
 * grammars (the contract's `press` keys and the `browser` fixture's
 * Playwright key names) parsed onto it as key strokes.
 */

import type { Input } from 'webdriver-bidi-protocol';
import { EngineError, parseKey, TestError, type KeyModifier } from 'e2e/engine';

/** A modifier key as the page sees it; `ControlOrMeta` resolves to one of these first. */
export type Modifier = Exclude<KeyModifier, 'ControlOrMeta'>;

/** Whether a keyboard call presses and releases its key, only holds it, or only releases it. */
export type KeyPhase = 'press' | 'keyDown' | 'keyUp';

/** One key of the US layout, as Playwright's `usKeyboardLayout` has it, with WebDriver's value for it. */
export interface KeyDefinition {
  readonly code: string;
  readonly key: string;
  /** The Windows virtual key code, without the side a modifier is on. */
  readonly keyCode: number;
  readonly shiftKey?: string;
  readonly shiftKeyCode?: number;
  /** 0 standard, 1 left, 2 right, 3 numpad. */
  readonly location: number;
  /** WebDriver's code point for the key when it is not `key` itself (WebDriver spec, "Keyboard actions"). */
  readonly value?: string;
  /** WebDriver's code point for the key with Shift held, when it is not `shiftKey` itself. */
  readonly shiftValue?: string;
}

type Entry = Omit<KeyDefinition, 'code' | 'location'> & { readonly location?: number };

/** Playwright's US layout (Apache-2.0), by `code`, with WebDriver's private-use code point for every key that has one. */
const LAYOUT: Readonly<Record<string, Entry>> = {
  Escape: { keyCode: 27, key: 'Escape', value: '' },
  F1: { keyCode: 112, key: 'F1', value: '' },
  F2: { keyCode: 113, key: 'F2', value: '' },
  F3: { keyCode: 114, key: 'F3', value: '' },
  F4: { keyCode: 115, key: 'F4', value: '' },
  F5: { keyCode: 116, key: 'F5', value: '' },
  F6: { keyCode: 117, key: 'F6', value: '' },
  F7: { keyCode: 118, key: 'F7', value: '' },
  F8: { keyCode: 119, key: 'F8', value: '' },
  F9: { keyCode: 120, key: 'F9', value: '' },
  F10: { keyCode: 121, key: 'F10', value: '' },
  F11: { keyCode: 122, key: 'F11', value: '' },
  F12: { keyCode: 123, key: 'F12', value: '' },
  Backquote: { keyCode: 192, key: '`', shiftKey: '~' },
  Digit1: { keyCode: 49, key: '1', shiftKey: '!' },
  Digit2: { keyCode: 50, key: '2', shiftKey: '@' },
  Digit3: { keyCode: 51, key: '3', shiftKey: '#' },
  Digit4: { keyCode: 52, key: '4', shiftKey: '$' },
  Digit5: { keyCode: 53, key: '5', shiftKey: '%' },
  Digit6: { keyCode: 54, key: '6', shiftKey: '^' },
  Digit7: { keyCode: 55, key: '7', shiftKey: '&' },
  Digit8: { keyCode: 56, key: '8', shiftKey: '*' },
  Digit9: { keyCode: 57, key: '9', shiftKey: '(' },
  Digit0: { keyCode: 48, key: '0', shiftKey: ')' },
  Minus: { keyCode: 189, key: '-', shiftKey: '_' },
  Equal: { keyCode: 187, key: '=', shiftKey: '+' },
  Backslash: { keyCode: 220, key: '\\', shiftKey: '|' },
  Backspace: { keyCode: 8, key: 'Backspace', value: '' },
  Tab: { keyCode: 9, key: 'Tab', value: '' },
  KeyQ: { keyCode: 81, key: 'q', shiftKey: 'Q' },
  KeyW: { keyCode: 87, key: 'w', shiftKey: 'W' },
  KeyE: { keyCode: 69, key: 'e', shiftKey: 'E' },
  KeyR: { keyCode: 82, key: 'r', shiftKey: 'R' },
  KeyT: { keyCode: 84, key: 't', shiftKey: 'T' },
  KeyY: { keyCode: 89, key: 'y', shiftKey: 'Y' },
  KeyU: { keyCode: 85, key: 'u', shiftKey: 'U' },
  KeyI: { keyCode: 73, key: 'i', shiftKey: 'I' },
  KeyO: { keyCode: 79, key: 'o', shiftKey: 'O' },
  KeyP: { keyCode: 80, key: 'p', shiftKey: 'P' },
  BracketLeft: { keyCode: 219, key: '[', shiftKey: '{' },
  BracketRight: { keyCode: 221, key: ']', shiftKey: '}' },
  CapsLock: { keyCode: 20, key: 'CapsLock' },
  KeyA: { keyCode: 65, key: 'a', shiftKey: 'A' },
  KeyS: { keyCode: 83, key: 's', shiftKey: 'S' },
  KeyD: { keyCode: 68, key: 'd', shiftKey: 'D' },
  KeyF: { keyCode: 70, key: 'f', shiftKey: 'F' },
  KeyG: { keyCode: 71, key: 'g', shiftKey: 'G' },
  KeyH: { keyCode: 72, key: 'h', shiftKey: 'H' },
  KeyJ: { keyCode: 74, key: 'j', shiftKey: 'J' },
  KeyK: { keyCode: 75, key: 'k', shiftKey: 'K' },
  KeyL: { keyCode: 76, key: 'l', shiftKey: 'L' },
  Semicolon: { keyCode: 186, key: ';', shiftKey: ':' },
  Quote: { keyCode: 222, key: "'", shiftKey: '"' },
  Enter: { keyCode: 13, key: 'Enter', value: '' },
  ShiftLeft: { keyCode: 16, key: 'Shift', location: 1, value: '' },
  KeyZ: { keyCode: 90, key: 'z', shiftKey: 'Z' },
  KeyX: { keyCode: 88, key: 'x', shiftKey: 'X' },
  KeyC: { keyCode: 67, key: 'c', shiftKey: 'C' },
  KeyV: { keyCode: 86, key: 'v', shiftKey: 'V' },
  KeyB: { keyCode: 66, key: 'b', shiftKey: 'B' },
  KeyN: { keyCode: 78, key: 'n', shiftKey: 'N' },
  KeyM: { keyCode: 77, key: 'm', shiftKey: 'M' },
  Comma: { keyCode: 188, key: ',', shiftKey: '<' },
  Period: { keyCode: 190, key: '.', shiftKey: '>' },
  Slash: { keyCode: 191, key: '/', shiftKey: '?' },
  ShiftRight: { keyCode: 16, key: 'Shift', location: 2, value: '' },
  ControlLeft: { keyCode: 17, key: 'Control', location: 1, value: '' },
  MetaLeft: { keyCode: 91, key: 'Meta', location: 1, value: '' },
  AltLeft: { keyCode: 18, key: 'Alt', location: 1, value: '' },
  Space: { keyCode: 32, key: ' ' },
  AltRight: { keyCode: 18, key: 'Alt', location: 2, value: '' },
  AltGraph: { keyCode: 225, key: 'AltGraph' },
  MetaRight: { keyCode: 92, key: 'Meta', location: 2, value: '' },
  ContextMenu: { keyCode: 93, key: 'ContextMenu' },
  ControlRight: { keyCode: 17, key: 'Control', location: 2, value: '' },
  PrintScreen: { keyCode: 44, key: 'PrintScreen' },
  ScrollLock: { keyCode: 145, key: 'ScrollLock' },
  Pause: { keyCode: 19, key: 'Pause', value: '' },
  PageUp: { keyCode: 33, key: 'PageUp', value: '' },
  PageDown: { keyCode: 34, key: 'PageDown', value: '' },
  Insert: { keyCode: 45, key: 'Insert', value: '' },
  Delete: { keyCode: 46, key: 'Delete', value: '' },
  Home: { keyCode: 36, key: 'Home', value: '' },
  End: { keyCode: 35, key: 'End', value: '' },
  ArrowLeft: { keyCode: 37, key: 'ArrowLeft', value: '' },
  ArrowUp: { keyCode: 38, key: 'ArrowUp', value: '' },
  ArrowRight: { keyCode: 39, key: 'ArrowRight', value: '' },
  ArrowDown: { keyCode: 40, key: 'ArrowDown', value: '' },
  AudioVolumeMute: { keyCode: 173, key: 'AudioVolumeMute' },
  AudioVolumeDown: { keyCode: 174, key: 'AudioVolumeDown' },
  AudioVolumeUp: { keyCode: 175, key: 'AudioVolumeUp' },
  MediaTrackNext: { keyCode: 176, key: 'MediaTrackNext' },
  MediaTrackPrevious: { keyCode: 177, key: 'MediaTrackPrevious' },
  MediaPlayPause: { keyCode: 179, key: 'MediaPlayPause' },
  NumLock: { keyCode: 144, key: 'NumLock' },
  NumpadDivide: { keyCode: 111, key: '/', location: 3, value: '' },
  NumpadMultiply: { keyCode: 106, key: '*', location: 3, value: '' },
  NumpadSubtract: { keyCode: 109, key: '-', location: 3, value: '' },
  Numpad7: { keyCode: 36, shiftKeyCode: 103, key: 'Home', shiftKey: '7', location: 3, value: '', shiftValue: '' },
  Numpad8: { keyCode: 38, shiftKeyCode: 104, key: 'ArrowUp', shiftKey: '8', location: 3, value: '', shiftValue: '' },
  Numpad9: { keyCode: 33, shiftKeyCode: 105, key: 'PageUp', shiftKey: '9', location: 3, value: '', shiftValue: '' },
  Numpad4: { keyCode: 37, shiftKeyCode: 100, key: 'ArrowLeft', shiftKey: '4', location: 3, value: '', shiftValue: '' },
  Numpad5: { keyCode: 12, shiftKeyCode: 101, key: 'Clear', shiftKey: '5', location: 3, shiftValue: '' },
  Numpad6: { keyCode: 39, shiftKeyCode: 102, key: 'ArrowRight', shiftKey: '6', location: 3, value: '', shiftValue: '' },
  NumpadAdd: { keyCode: 107, key: '+', location: 3, value: '' },
  Numpad1: { keyCode: 35, shiftKeyCode: 97, key: 'End', shiftKey: '1', location: 3, value: '', shiftValue: '' },
  Numpad2: { keyCode: 40, shiftKeyCode: 98, key: 'ArrowDown', shiftKey: '2', location: 3, value: '', shiftValue: '' },
  Numpad3: { keyCode: 34, shiftKeyCode: 99, key: 'PageDown', shiftKey: '3', location: 3, value: '', shiftValue: '' },
  Numpad0: { keyCode: 45, shiftKeyCode: 96, key: 'Insert', shiftKey: '0', location: 3, value: '', shiftValue: '' },
  NumpadDecimal: { keyCode: 46, shiftKeyCode: 110, key: '\0', shiftKey: '.', location: 3, value: '', shiftValue: '' },
  NumpadEnter: { keyCode: 13, key: 'Enter', location: 3, value: '' },
};

/** Every key of the layout, by `code`. */
export const KEYS: ReadonlyMap<string, KeyDefinition> = new Map(Object.entries(LAYOUT).map(([code, entry]) => [code, { ...entry, code, location: entry.location ?? 0 }]));

/** The key a modifier presses, its left-hand one, as Playwright presses it. */
export const MODIFIER_KEYS: Readonly<Record<Modifier, KeyDefinition>> = {
  Shift: KEYS.get('ShiftLeft')!,
  Control: KEYS.get('ControlLeft')!,
  Alt: KEYS.get('AltLeft')!,
  Meta: KEYS.get('MetaLeft')!,
};

/** The modifier each modifier key holds, by `code`, on either side. */
export const MODIFIER_CODES: ReadonlyMap<string, Modifier> = new Map(
  [...KEYS.values()].flatMap(({ code, key }) => (Object.hasOwn(MODIFIER_KEYS, key) ? [[code, key as Modifier] as const] : [])),
);

/** A key a name presses, and, for a character, whether it is that key's shifted one, which Shift then does not change. */
interface NamedKey {
  readonly definition: KeyDefinition;
  readonly shifted?: true;
}

/**
 * Every name a key goes by: its `code`, a bare modifier, Playwright's
 * aliases of Enter, and each character the main block types; a character
 * is never a key of the numpad or a side, as WebDriver reads one.
 */
const NAMES: ReadonlyMap<string, NamedKey> = (() => {
  const names = new Map<string, NamedKey>();
  for (const definition of KEYS.values()) {
    names.set(definition.code, { definition });
    if (definition.location !== 0) continue;
    if ([...definition.key].length === 1) names.set(definition.key, { definition });
    if (definition.shiftKey !== undefined) names.set(definition.shiftKey, { definition, shifted: true });
  }
  for (const [modifier, definition] of Object.entries(MODIFIER_KEYS)) names.set(modifier, { definition });
  for (const alias of ['\n', '\r']) names.set(alias, { definition: KEYS.get('Enter')! });
  return names;
})();

/** The code each WebDriver value the driver sends presses. */
const CODES_BY_VALUE: ReadonlyMap<string, string> = (() => {
  const codes = new Map<string, string>();
  for (const definition of KEYS.values()) {
    for (const shifted of [false, true]) {
      const value = keyValue(definition, shifted);
      if (value !== undefined && !codes.has(value)) codes.set(value, definition.code);
    }
  }
  return codes;
})();

/** One key of a keyboard call: the key, its phase, and the modifiers a press holds around it. */
export interface KeyStroke {
  readonly definition: KeyDefinition;
  /** Set for a shifted character (`A`, `!`), which stays shifted whether Shift is held or not; else the key follows Shift. */
  readonly shifted?: true;
  readonly phase: KeyPhase;
  readonly chord: readonly Modifier[];
}

/** A modifier as the page sees it: `ControlOrMeta` is Meta on macOS and Control elsewhere. */
function resolveModifier(modifier: KeyModifier): Modifier {
  if (modifier === 'ControlOrMeta') return process.platform === 'darwin' ? 'Meta' : 'Control';
  return modifier;
}

/** Whether `name` is a modifier key's name. */
function isModifier(name: string): name is KeyModifier {
  return name === 'ControlOrMeta' || Object.hasOwn(MODIFIER_KEYS, name);
}

/** WebDriver's value for `definition`, with Shift held or not; undefined when WebDriver defines none (a media key, Numpad5 with NumLock off). */
export function keyValue(definition: KeyDefinition, shifted: boolean): string | undefined {
  const value = shifted && definition.shiftKey !== undefined ? (definition.shiftValue ?? definition.shiftKey) : (definition.value ?? definition.key);
  return [...value].length === 1 ? value : undefined;
}

/** The layout code a WebDriver value presses, or the value itself for one the layout has no key for. */
export function codeOfValue(value: string): string {
  return CODES_BY_VALUE.get(value) ?? value;
}

/** Whether `stroke` presses its key's shifted value, given whether Shift is held before it. */
export function isShifted(stroke: KeyStroke, shiftHeld: boolean): boolean {
  return stroke.shifted ?? (shiftHeld || (stroke.phase === 'press' && stroke.chord.includes('Shift')));
}

/**
 * One key of the contract grammar (`parseKey`) as a key stroke; a key off
 * the US layout Playwright types on is an unknown key, as there.
 */
export function pressStroke(key: string): KeyStroke {
  const parsed = parseKey(key);
  const named = parsed === undefined ? undefined : NAMES.get(parsed.key.kind === 'named' ? parsed.key.name : parsed.key.char);
  if (parsed === undefined || named === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `Unknown key: "${key}"`, { retryable: false });
  return { ...named, phase: 'press', chord: parsed.modifiers.map(resolveModifier) };
}

/**
 * One `browser.keyboard` call as a key stroke. The call takes Playwright's
 * key names (a bare modifier, `KeyB`, `Digit1`, a named key, one
 * character) and, for `press`, `+`-joined modifiers before the key.
 */
export function fixtureKeyStroke(key: string, phase: KeyPhase): KeyStroke {
  const parts = key === '+' ? ['+'] : key.endsWith('++') ? [...key.slice(0, -2).split('+'), '+'] : key.split('+');
  if (parts.some((part) => part === '') || (phase !== 'press' && parts.length > 1)) {
    throw new TestError('INVALID_ARGUMENT', `keyboard.${phase === 'press' ? 'press' : phase === 'keyDown' ? 'down' : 'up'} cannot read the key "${key}"`);
  }
  const chord = parts.slice(0, -1).map((part) => {
    if (!isModifier(part)) throw new TestError('INVALID_ARGUMENT', `"${part}" in "${key}" is not a modifier`);
    return resolveModifier(part);
  });
  const name = parts.at(-1)!;
  const named = NAMES.get(name === 'ControlOrMeta' ? resolveModifier(name) : name);
  if (named === undefined) throw new TestError('INVALID_ARGUMENT', `Unknown key: "${name}"`);
  return { ...named, phase, chord };
}

/**
 * The key source of `stroke`, with Shift held before it or not: a press
 * holds its chord's modifiers around the key. A key WebDriver has no value
 * for is refused; on Chromium it goes as CDP key events instead
 * (`chromiumKeyCommands`).
 */
export function strokeSource(stroke: KeyStroke, shiftHeld: boolean): Input.KeySourceActions {
  const { definition } = stroke;
  const shifted = isShifted(stroke, shiftHeld);
  const value = keyValue(definition, shifted);
  if (value === undefined) {
    const numLock = definition.location === 3 && !shifted ? ' with NumLock off' : '';
    throw new EngineError('UNSUPPORTED_CAPABILITY', `WebDriver defines no key value for "${definition.code}"${numLock} (key "${shifted ? definition.shiftKey : definition.key}"), so a WebDriver BiDi key action cannot press it`, { retryable: false });
  }
  if (stroke.phase !== 'press') return { type: 'key', id: 'keyboard', actions: [{ type: stroke.phase, value }] };
  const modifiers = stroke.chord.map(modifierValue);
  return {
    type: 'key',
    id: 'keyboard',
    actions: [
      ...modifiers.map((code) => ({ type: 'keyDown' as const, value: code })),
      { type: 'keyDown', value },
      { type: 'keyUp', value },
      ...modifiers.toReversed().map((code) => ({ type: 'keyUp' as const, value: code })),
    ],
  };
}

/** A modifier's WebDriver value, its left-hand key's. */
export function modifierValue(modifier: KeyModifier): string {
  return MODIFIER_KEYS[resolveModifier(modifier)].value!;
}
