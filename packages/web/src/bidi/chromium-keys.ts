/**
 * Key presses Chromium takes as CDP `Input.dispatchKeyEvent` (through the
 * mapper's `goog:cdp` passthrough) because a WebDriver BiDi key action
 * cannot carry them: the media keys and Numpad5 with NumLock off, which
 * WebDriver gives no key value, and, on macOS, the combinations Chromium
 * runs an editing command for only when the key event names it, as
 * Playwright sends them. Every other key stays a BiDi key action.
 */

import type { KeyModifier } from 'e2e/engine';
import type { CdpCommand } from './cdp.ts';

/** A modifier key as the page sees it; `ControlOrMeta` resolves to one of these first. */
export type Modifier = Exclude<KeyModifier, 'ControlOrMeta'>;

/** Whether a keyboard call presses and releases its key, only holds it, or only releases it. */
export type KeyPhase = 'press' | 'keyDown' | 'keyUp';

/** One key of a keyboard call: a Playwright key name or one character, its phase, and the modifiers a press holds around it. */
export interface KeyStroke {
  readonly name: string;
  readonly phase: KeyPhase;
  readonly chord: readonly Modifier[];
}

/** One key of Playwright's US layout: its key code and `key`, and both again with Shift held where Shift changes them. */
interface KeyDefinition {
  readonly keyCode: number;
  readonly key: string;
  readonly shiftKey?: string;
  readonly shiftKeyCode?: number;
  readonly location?: number;
}

/** The letter keys, `KeyA` to `KeyZ`. */
const LETTERS: Readonly<Record<string, KeyDefinition>> = Object.fromEntries(
  Array.from({ length: 26 }, (_, index) => {
    const upper = String.fromCharCode(65 + index);
    return [`Key${upper}`, { keyCode: 65 + index, key: upper.toLowerCase(), shiftKey: upper }];
  }),
);

/** Playwright's US layout for every key this module may send, by `code`. */
const KEYS: Readonly<Record<string, KeyDefinition>> = {
  ...LETTERS,
  Escape: { keyCode: 27, key: 'Escape' },
  F5: { keyCode: 116, key: 'F5' },
  Backspace: { keyCode: 8, key: 'Backspace' },
  Tab: { keyCode: 9, key: 'Tab' },
  Quote: { keyCode: 222, key: "'", shiftKey: '"' },
  PageUp: { keyCode: 33, key: 'PageUp' },
  PageDown: { keyCode: 34, key: 'PageDown' },
  Delete: { keyCode: 46, key: 'Delete' },
  Home: { keyCode: 36, key: 'Home' },
  End: { keyCode: 35, key: 'End' },
  ArrowLeft: { keyCode: 37, key: 'ArrowLeft' },
  ArrowUp: { keyCode: 38, key: 'ArrowUp' },
  ArrowRight: { keyCode: 39, key: 'ArrowRight' },
  ArrowDown: { keyCode: 40, key: 'ArrowDown' },
  Numpad5: { keyCode: 12, key: 'Clear', shiftKey: '5', shiftKeyCode: 101, location: 3 },
  NumpadSubtract: { keyCode: 109, key: '-', location: 3 },
  AudioVolumeMute: { keyCode: 173, key: 'AudioVolumeMute' },
  AudioVolumeDown: { keyCode: 174, key: 'AudioVolumeDown' },
  AudioVolumeUp: { keyCode: 175, key: 'AudioVolumeUp' },
  MediaTrackNext: { keyCode: 176, key: 'MediaTrackNext' },
  MediaTrackPrevious: { keyCode: 177, key: 'MediaTrackPrevious' },
  MediaPlayPause: { keyCode: 179, key: 'MediaPlayPause' },
};

/** The left-hand modifier keys a chord presses, as the US layout names them. */
const MODIFIER_KEYS: Readonly<Record<Modifier, { readonly code: string; readonly keyCode: number }>> = {
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
};

/** Each modifier's bit in CDP's `modifiers` mask. */
const MODIFIER_BITS: Readonly<Record<Modifier, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** The order a shortcut names its modifiers in `MAC_EDITING_COMMANDS`. */
const SHORTCUT_ORDER: readonly Modifier[] = ['Shift', 'Control', 'Alt', 'Meta'];

/**
 * The editing commands macOS binds to each shortcut, by modifiers and
 * `code`, as Chromium names them: Playwright's `macEditingCommands` table
 * (Apache-2.0) without the commands that insert text, which Chromium does
 * not run from a key event.
 */
export const MAC_EDITING_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  'Backspace': ['deleteBackward'],
  'Escape': ['cancelOperation'],
  'ArrowUp': ['moveUp'],
  'ArrowDown': ['moveDown'],
  'ArrowLeft': ['moveLeft'],
  'ArrowRight': ['moveRight'],
  'F5': ['complete'],
  'Delete': ['deleteForward'],
  'Home': ['scrollToBeginningOfDocument'],
  'End': ['scrollToEndOfDocument'],
  'PageUp': ['scrollPageUp'],
  'PageDown': ['scrollPageDown'],
  'Shift+Backspace': ['deleteBackward'],
  'Shift+Escape': ['cancelOperation'],
  'Shift+ArrowUp': ['moveUpAndModifySelection'],
  'Shift+ArrowDown': ['moveDownAndModifySelection'],
  'Shift+ArrowLeft': ['moveLeftAndModifySelection'],
  'Shift+ArrowRight': ['moveRightAndModifySelection'],
  'Shift+F5': ['complete'],
  'Shift+Delete': ['deleteForward'],
  'Shift+Home': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+End': ['moveToEndOfDocumentAndModifySelection'],
  'Shift+PageUp': ['pageUpAndModifySelection'],
  'Shift+PageDown': ['pageDownAndModifySelection'],
  'Shift+Numpad5': ['delete'],
  'Control+Tab': ['selectNextKeyView'],
  'Control+KeyA': ['moveToBeginningOfParagraph'],
  'Control+KeyB': ['moveBackward'],
  'Control+KeyD': ['deleteForward'],
  'Control+KeyE': ['moveToEndOfParagraph'],
  'Control+KeyF': ['moveForward'],
  'Control+KeyH': ['deleteBackward'],
  'Control+KeyK': ['deleteToEndOfParagraph'],
  'Control+KeyL': ['centerSelectionInVisibleArea'],
  'Control+KeyN': ['moveDown'],
  'Control+KeyO': ['moveBackward'],
  'Control+KeyP': ['moveUp'],
  'Control+KeyT': ['transpose'],
  'Control+KeyV': ['pageDown'],
  'Control+KeyY': ['yank'],
  'Control+Backspace': ['deleteBackwardByDecomposingPreviousCharacter'],
  'Control+ArrowUp': ['scrollPageUp'],
  'Control+ArrowDown': ['scrollPageDown'],
  'Control+ArrowLeft': ['moveToLeftEndOfLine'],
  'Control+ArrowRight': ['moveToRightEndOfLine'],
  'Shift+Control+Tab': ['selectPreviousKeyView'],
  'Shift+Control+KeyA': ['moveToBeginningOfParagraphAndModifySelection'],
  'Shift+Control+KeyB': ['moveBackwardAndModifySelection'],
  'Shift+Control+KeyE': ['moveToEndOfParagraphAndModifySelection'],
  'Shift+Control+KeyF': ['moveForwardAndModifySelection'],
  'Shift+Control+KeyN': ['moveDownAndModifySelection'],
  'Shift+Control+KeyP': ['moveUpAndModifySelection'],
  'Shift+Control+KeyV': ['pageDownAndModifySelection'],
  'Shift+Control+Backspace': ['deleteBackwardByDecomposingPreviousCharacter'],
  'Shift+Control+ArrowUp': ['scrollPageUp'],
  'Shift+Control+ArrowDown': ['scrollPageDown'],
  'Shift+Control+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Control+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Alt+Escape': ['complete'],
  'Alt+ArrowUp': ['moveBackward', 'moveToBeginningOfParagraph'],
  'Alt+ArrowDown': ['moveForward', 'moveToEndOfParagraph'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Alt+Delete': ['deleteWordForward'],
  'Alt+PageUp': ['pageUp'],
  'Alt+PageDown': ['pageDown'],
  'Shift+Alt+Backspace': ['deleteWordBackward'],
  'Shift+Alt+Escape': ['complete'],
  'Shift+Alt+ArrowUp': ['moveParagraphBackwardAndModifySelection'],
  'Shift+Alt+ArrowDown': ['moveParagraphForwardAndModifySelection'],
  'Shift+Alt+ArrowLeft': ['moveWordLeftAndModifySelection'],
  'Shift+Alt+ArrowRight': ['moveWordRightAndModifySelection'],
  'Shift+Alt+Delete': ['deleteWordForward'],
  'Shift+Alt+PageUp': ['pageUp'],
  'Shift+Alt+PageDown': ['pageDown'],
  'Control+Alt+KeyB': ['moveWordBackward'],
  'Control+Alt+KeyF': ['moveWordForward'],
  'Control+Alt+Backspace': ['deleteWordBackward'],
  'Shift+Control+Alt+KeyB': ['moveWordBackwardAndModifySelection'],
  'Shift+Control+Alt+KeyF': ['moveWordForwardAndModifySelection'],
  'Shift+Control+Alt+Backspace': ['deleteWordBackward'],
  'Meta+NumpadSubtract': ['cancel'],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Meta+ArrowLeft': ['moveToLeftEndOfLine'],
  'Meta+ArrowRight': ['moveToRightEndOfLine'],
  'Shift+Meta+NumpadSubtract': ['cancel'],
  'Shift+Meta+Backspace': ['deleteToBeginningOfLine'],
  'Shift+Meta+ArrowUp': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowDown': ['moveToEndOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Meta+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
};

/** The media keys, which WebDriver gives no key value. */
const MEDIA_KEYS: ReadonlySet<string> = new Set(['AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause']);

/**
 * Whether WebDriver has no key value for the Playwright key `name` pressed
 * with or without Shift: a media key, or Numpad5 with NumLock off (Clear).
 */
export function lacksWebDriverValue(name: string, shifted: boolean): boolean {
  return MEDIA_KEYS.has(name) || (name === 'Numpad5' && !shifted);
}

/** One CDP command of a key press. */
export type CdpKeyCommand = CdpCommand<'Input.dispatchKeyEvent' | 'Input.cancelDragging'>;

/** What a Chromium key press needs to know about the keyboard before it: the modifiers held, the platform, and the keys CDP holds down. */
export interface ChromiumKeyboard {
  readonly held: ReadonlySet<Modifier>;
  /** Codes of the keys an earlier CDP key event holds down. */
  readonly pressed: ReadonlySet<string>;
  readonly mac: boolean;
}

/**
 * A key name as the US layout's `code`, and, for a character, whether it is
 * that key's shifted one, which Shift then does not change, as Playwright
 * reads a character; a code follows the Shift held. Undefined for a key this
 * module never sends. A character is never a numpad key.
 */
function codeOf(name: string): { code: string; shifted?: boolean } | undefined {
  if (Object.hasOwn(KEYS, name)) return { code: name };
  if ([...name].length !== 1) return undefined;
  for (const [code, definition] of Object.entries(KEYS)) {
    if (definition.location !== undefined) continue;
    if (definition.key === name) return { code, shifted: false };
    if (definition.shiftKey === name) return { code, shifted: true };
  }
  return undefined;
}

/** The editing commands macOS binds to `code` under `modifiers`. */
export function macEditingCommands(code: string, modifiers: ReadonlySet<Modifier>): readonly string[] {
  const shortcut = [...SHORTCUT_ORDER.filter((modifier) => modifiers.has(modifier)), code].join('+');
  return MAC_EDITING_COMMANDS[shortcut] ?? [];
}

/** The CDP `modifiers` mask of `modifiers`. */
function mask(modifiers: ReadonlySet<Modifier>): number {
  let bits = 0;
  for (const modifier of modifiers) bits |= MODIFIER_BITS[modifier];
  return bits;
}

/**
 * The CDP commands that carry `stroke` on Chromium, or undefined when a BiDi
 * key action presses it the same way. A key goes to CDP when WebDriver has
 * no value for it, when it is a macOS editing shortcut, or, to release it,
 * when CDP holds it down. A chord's modifiers the keyboard does not hold
 * already are pressed and released around the key in the same commands, so
 * the mapper's own modifier state is left as it was.
 */
export function chromiumKeyCommands(stroke: KeyStroke, keyboard: ChromiumKeyboard): CdpKeyCommand[] | undefined {
  const resolved = codeOf(stroke.name);
  if (resolved === undefined) return undefined;
  const { code } = resolved;
  const definition = KEYS[code]!;
  const modifiers = new Set<Modifier>([...keyboard.held, ...(stroke.phase === 'press' ? stroke.chord : [])]);
  const shifted = resolved.shifted ?? modifiers.has('Shift');
  const commands = keyboard.mac ? macEditingCommands(code, modifiers) : [];
  if (stroke.phase === 'keyUp' ? !keyboard.pressed.has(code) : !lacksWebDriverValue(code, shifted) && commands.length === 0) return undefined;
  const key = shifted && definition.shiftKey !== undefined ? definition.shiftKey : definition.key;
  const keyCode = shifted && definition.shiftKeyCode !== undefined ? definition.shiftKeyCode : definition.keyCode;
  const typesText = [...key].length === 1 && !modifiers.has('Control') && !modifiers.has('Alt') && !modifiers.has('Meta');
  const location = definition.location ?? 0;
  const event = { windowsVirtualKeyCode: keyCode, code, key, location, isKeypad: location === 3 };
  const down: CdpKeyCommand = {
    method: 'Input.dispatchKeyEvent',
    params: {
      ...event,
      type: typesText ? 'keyDown' : 'rawKeyDown',
      modifiers: mask(modifiers),
      ...(typesText ? { text: key, unmodifiedText: key } : {}),
      autoRepeat: keyboard.pressed.has(code),
      commands: [...commands],
    },
  };
  const up: CdpKeyCommand = { method: 'Input.dispatchKeyEvent', params: { ...event, type: 'keyUp', modifiers: mask(modifiers) } };
  const cancelDrag: CdpKeyCommand[] = code === 'Escape' && !modifiers.has('Alt') && !modifiers.has('Control') && !modifiers.has('Meta')
    ? [{ method: 'Input.cancelDragging', params: {} }]
    : [];
  if (stroke.phase === 'keyDown') return [...cancelDrag, down];
  if (stroke.phase === 'keyUp') return [up];
  const added = stroke.chord.filter((modifier) => !keyboard.held.has(modifier));
  const holding = new Set(keyboard.held);
  const presses = added.map((modifier) => {
    holding.add(modifier);
    return modifierEvent(modifier, 'rawKeyDown', holding);
  });
  const releases = added.toReversed().map((modifier) => {
    holding.delete(modifier);
    return modifierEvent(modifier, 'keyUp', holding);
  });
  return [...presses, ...cancelDrag, down, up, ...releases];
}

/** The CDP event that presses or releases one modifier key, with the modifiers held after it. */
function modifierEvent(modifier: Modifier, type: 'rawKeyDown' | 'keyUp', holding: ReadonlySet<Modifier>): CdpKeyCommand {
  const { code, keyCode } = MODIFIER_KEYS[modifier];
  return { method: 'Input.dispatchKeyEvent', params: { type, windowsVirtualKeyCode: keyCode, code, key: modifier, location: 1, isKeypad: false, modifiers: mask(holding) } };
}

/** Whether a CDP key command holds `code` down after it (true), releases it (false), or leaves it (undefined). */
export function holdsAfter(command: CdpKeyCommand): { code: string; down: boolean } | undefined {
  if (command.method !== 'Input.dispatchKeyEvent') return undefined;
  const { type, code } = command.params as { type: string; code: string };
  return { code, down: type !== 'keyUp' };
}
