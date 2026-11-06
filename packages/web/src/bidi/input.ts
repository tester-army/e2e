/** The contract's key grammar and pointer gestures as WebDriver BiDi `input.performActions` sources. */

import type { Input } from 'webdriver-bidi-protocol';
import { EngineError, parseKey, TestError, type KeyModifier, type KeyName } from 'e2e/engine';
import { lacksWebDriverValue, type KeyPhase, type KeyStroke, type Modifier } from './chromium-keys.ts';

/** WebDriver's code points for the named keys (WebDriver spec, "Keyboard actions"). */
const KEY_CODES: Readonly<Record<KeyName, string>> = {
  Enter: '',
  Escape: '',
  Tab: '',
  Backspace: '',
  Delete: '',
  Insert: '',
  Space: ' ',
  ArrowUp: '',
  ArrowDown: '',
  ArrowLeft: '',
  ArrowRight: '',
  Home: '',
  End: '',
  PageUp: '',
  PageDown: '',
  F1: '',
  F2: '',
  F3: '',
  F4: '',
  F5: '',
  F6: '',
  F7: '',
  F8: '',
  F9: '',
  F10: '',
  F11: '',
  F12: '',
};

const MODIFIER_CODES: Readonly<Record<Modifier, string>> = {
  Shift: '',
  Control: '',
  Alt: '',
  Meta: '',
};

/** Shift's WebDriver code point. */
export const SHIFT_KEY = MODIFIER_CODES.Shift;

/** Every modifier's WebDriver code point. */
export const MODIFIER_VALUES: ReadonlySet<string> = new Set(Object.values(MODIFIER_CODES));

/** A modifier as the page sees it: `ControlOrMeta` is Meta on macOS and Control elsewhere. */
function resolveModifier(modifier: KeyModifier): Modifier {
  if (modifier === 'ControlOrMeta') return process.platform === 'darwin' ? 'Meta' : 'Control';
  return modifier;
}

/** A modifier's WebDriver code point. */
function modifierCode(modifier: KeyModifier): string {
  return MODIFIER_CODES[resolveModifier(modifier)];
}

/** Each modifier's WebDriver code points, its left-hand key's and its right-hand key's. */
const MODIFIER_VALUES_BY_NAME: Readonly<Record<Modifier, readonly string[]>> = {
  Shift: ['\uE008', '\uE050'],
  Control: ['\uE009', '\uE051'],
  Alt: ['\uE00A', '\uE052'],
  Meta: ['\uE03D', '\uE053'],
};

/** The key source that presses one key of the contract grammar with its modifiers held; a character off the US keyboard Playwright types on is an unknown key, as there. */
export function pressSource(key: string): Input.KeySourceActions {
  const parsed = parseKey(key);
  if (parsed === undefined || (parsed.key.kind === 'char' && !/^[\x20-\x7e]$/.test(parsed.key.char))) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `Unknown key: "${key}"`, { retryable: false });
  }
  const value = parsed.key.kind === 'named' ? KEY_CODES[parsed.key.name] : parsed.key.char;
  const modifiers = parsed.modifiers.map(modifierCode);
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

/** The key source that types `text` one grapheme at a time, as a person would; a newline is Enter. */
export function typeSource(text: string): Input.KeySourceActions {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const actions: Input.KeySourceAction[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const value = segment === '\n' || segment === '\r\n' ? KEY_CODES.Enter : segment;
    actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
  }
  return { type: 'key', id: 'keyboard', actions };
}

/** Pointer button numbers: the primary and the secondary (context-menu) button. */
export type PointerButton = 0 | 2;

/** How a click presses: which button, how many times, how long, with which modifiers held. */
export interface ClickOptions {
  readonly button?: PointerButton;
  readonly clicks?: number;
  /** How long each press is held before release. */
  readonly holdMs?: number;
  readonly modifiers?: readonly KeyModifier[];
}

/**
 * The sources of a click at a viewport point: a mouse move, then each press
 * and release, with any modifiers held on a key source across the same ticks.
 */
export function clickSources(x: number, y: number, options: ClickOptions = {}): Input.SourceActions[] {
  const button = options.button ?? 0;
  const pointer: Input.PointerSourceAction[] = [{ type: 'pointerMove', x, y, origin: 'viewport' }];
  for (let click = 0; click < (options.clicks ?? 1); click += 1) {
    pointer.push({ type: 'pointerDown', button });
    if (options.holdMs !== undefined) pointer.push({ type: 'pause', duration: options.holdMs });
    pointer.push({ type: 'pointerUp', button });
  }
  return withModifiers(mouse(pointer), options.modifiers ?? []);
}

/** The source that moves the mouse to a viewport point. */
export function moveSources(x: number, y: number): Input.SourceActions[] {
  return [mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }])];
}

/** The source that presses the primary button at a viewport point and holds it (`mouse.down`). */
export function pressDownSources(x: number, y: number): Input.SourceActions[] {
  return [mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }])];
}

/** The source that releases the primary button where the mouse is (`mouse.up`). */
export function releaseSources(): Input.SourceActions[] {
  return [mouse([{ type: 'pointerUp', button: 0 }])];
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
  return { name: parts.at(-1)!, phase, chord };
}

/**
 * The key source of one `browser.keyboard` call (`fixtureKeyStroke`). A
 * letter is upper case while Shift is held, by this call or a
 * `keyboard.down` before it, as Playwright types it.
 */
export function fixtureKeySource(key: string, phase: KeyPhase, shiftHeld: boolean): Input.KeySourceActions {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

/** The key source of a key stroke the `browser` fixture names, with Shift held before it or not. */
export function strokeSource(stroke: KeyStroke, shiftHeld: boolean): Input.KeySourceActions {
  const value = fixtureKeyValue(stroke.name, shiftHeld || stroke.chord.includes('Shift'));
  if (stroke.phase !== 'press') return { type: 'key', id: 'keyboard', actions: [{ type: stroke.phase, value }] };
  const modifiers = stroke.chord.map((modifier) => MODIFIER_CODES[modifier]);
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

/** A key of the contract grammar (`pressSource`) as a key stroke, which Chromium may take as CDP key events instead. */
export function pressStroke(key: string): KeyStroke {
  const parsed = parseKey(key);
  if (parsed === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `Unknown key: "${key}"`, { retryable: false });
  return { name: parsed.key.kind === 'named' ? parsed.key.name : parsed.key.char, phase: 'press', chord: parsed.modifiers.map(resolveModifier) };
}

/** The modifiers held down, read off whether each key is held by its WebDriver value. */
export function heldModifiers(isHeld: (value: string) => boolean): Set<Modifier> {
  const held = new Set<Modifier>();
  for (const [modifier, values] of Object.entries(MODIFIER_VALUES_BY_NAME) as [Modifier, readonly string[]][]) {
    if (values.some(isHeld)) held.add(modifier);
  }
  return held;
}

/** Whether `name` is a modifier key's name. */
function isModifier(name: string): name is KeyModifier {
  return name === 'ControlOrMeta' || Object.hasOwn(MODIFIER_CODES, name);
}

/** Playwright key names for keys of the right-hand side and the numpad, as WebDriver code points. */
const LOCATED_KEYS: Readonly<Record<string, string>> = {
  ShiftLeft: '\uE008',
  ControlLeft: '\uE009',
  AltLeft: '\uE00A',
  MetaLeft: '\uE03D',
  ShiftRight: '\uE050',
  ControlRight: '\uE051',
  AltRight: '\uE052',
  MetaRight: '\uE053',
  NumpadEnter: '\uE007',
  NumpadMultiply: '\uE024',
  NumpadAdd: '\uE025',
  NumpadSubtract: '\uE027',
  NumpadDivide: '\uE029',
};

/**
 * The numpad keys NumLock changes, as WebDriver code points: without Shift
 * the key the US layout presses with NumLock off, with it the digit or the
 * decimal point, as Playwright's layout has them. Numpad5 with NumLock off
 * (Clear) has no WebDriver value (`lacksWebDriverValue`).
 */
const NUMPAD_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  Numpad0: ['\uE05C', '\uE01A'],
  Numpad1: ['\uE056', '\uE01B'],
  Numpad2: ['\uE05B', '\uE01C'],
  Numpad3: ['\uE055', '\uE01D'],
  Numpad4: ['\uE058', '\uE01E'],
  Numpad5: ['', '\uE01F'],
  Numpad6: ['\uE05A', '\uE020'],
  Numpad7: ['\uE057', '\uE021'],
  Numpad8: ['\uE059', '\uE022'],
  Numpad9: ['\uE054', '\uE023'],
  NumpadDecimal: ['\uE05D', '\uE028'],
};

/** Each digit and punctuation key code's character on the US layout, unshifted and with Shift. */
const CODE_CHARACTERS: Readonly<Record<string, readonly [string, string]>> = {
  Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')'],
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
};

/**
 * One Playwright key name as a WebDriver key value. A key code held with
 * Shift sends its shifted character, as the US layout gives it, since
 * Chromium does not shift a code itself.
 */
function fixtureKeyValue(name: string, shifted: boolean): string {
  if (lacksWebDriverValue(name, shifted)) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `WebDriver defines no key value for "${name}"${name === 'Numpad5' ? ' with NumLock off (Clear)' : ''}, so a WebDriver BiDi key action cannot press it`, { retryable: false });
  }
  if (isModifier(name)) return modifierCode(name);
  if (Object.hasOwn(KEY_CODES, name)) return KEY_CODES[name as KeyName];
  if (Object.hasOwn(LOCATED_KEYS, name)) return LOCATED_KEYS[name]!;
  if (Object.hasOwn(NUMPAD_KEYS, name)) return NUMPAD_KEYS[name]![shifted ? 1 : 0];
  if (name === '\n' || name === '\r') return KEY_CODES.Enter;
  const physical = /^Key([A-Z])$/.exec(name)?.[1];
  if (physical !== undefined) return shifted ? physical : physical.toLowerCase();
  if (/^[a-z]$/.test(name) && shifted) return name.toUpperCase();
  if (Object.hasOwn(CODE_CHARACTERS, name)) return CODE_CHARACTERS[name]![shifted ? 1 : 0];
  if (/^[\x20-\x7e]$/.test(name)) return name;
  throw new TestError('INVALID_ARGUMENT', `Unknown key: "${name}"`);
}

/** Steps a drag moves through between its press and its release, so drag-and-drop libraries see motion. */
const DRAG_STEPS = 5;

/** A drag's points: its start, then each step to `to`. */
export function dragPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const path = [{ x: from.x, y: from.y }];
  for (let index = 1; index <= DRAG_STEPS; index += 1) {
    path.push({
      x: Math.round(from.x + ((to.x - from.x) * index) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * index) / DRAG_STEPS),
    });
  }
  return path;
}

/** How long each step of a drag that lasts `durationMs` takes. */
export function dragStepMs(durationMs: number): number {
  return Math.round(durationMs / DRAG_STEPS);
}

/** The sources of a drag: `press` presses at `from`; `release` then moves to `to` over `durationMs` and releases there. */
export function dragSources(from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 0): { press: Input.SourceActions[]; release: Input.SourceActions[] } {
  const step = dragStepMs(durationMs);
  const [start, ...steps] = dragPath(from, to);
  return {
    press: [mouse([{ type: 'pointerMove', x: start!.x, y: start!.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }])],
    release: [mouse([
      ...steps.map((point) => ({ type: 'pointerMove' as const, x: point.x, y: point.y, origin: 'viewport' as const, ...(step > 0 ? { duration: step } : {}) })),
      { type: 'pointerUp', button: 0 },
    ])],
  };
}

/** The source of one wheel gesture at a viewport point. */
export function wheelSources(x: number, y: number, deltaX: number, deltaY: number): Input.SourceActions[] {
  return [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x, y, deltaX, deltaY, origin: 'viewport' }] }];
}

/** The one mouse pointer source every pointer action of the driver goes through. */
export function mouse(actions: Input.PointerSourceAction[]): Input.PointerSourceActions {
  return { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions };
}

/**
 * Holds `modifiers` for the whole pointer sequence: the key source presses
 * them on the first ticks, pauses while the pointer acts, and releases them
 * after it.
 */
function withModifiers(pointer: Input.PointerSourceActions, modifiers: readonly KeyModifier[]): Input.SourceActions[] {
  if (modifiers.length === 0) return [pointer];
  const codes = modifiers.map(modifierCode);
  const keys: Input.KeySourceAction[] = [
    ...codes.map((value) => ({ type: 'keyDown' as const, value })),
    ...pointer.actions.map(() => ({ type: 'pause' as const })),
    ...codes.map((value) => ({ type: 'keyUp' as const, value })),
  ];
  const lead: Input.PointerSourceAction[] = codes.map(() => ({ type: 'pause' }));
  return [{ type: 'key', id: 'keyboard', actions: keys }, { ...pointer, actions: [...lead, ...pointer.actions] }];
}
