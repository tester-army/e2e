/**
 * Key presses Chromium takes as CDP `Input.dispatchKeyEvent` (through the
 * mapper's `goog:cdp` passthrough) because a WebDriver BiDi key action
 * cannot carry them: the keys WebDriver gives no key value (the media
 * keys, Numpad5 with NumLock off), and, on macOS, the combinations Chromium
 * runs an editing command for only when the key event names it, as
 * Playwright sends them. Every other key stays a BiDi key action.
 */

import type { CdpCommand } from './cdp.ts';
import { isShifted, keyValue, MODIFIER_KEYS, type KeyStroke, type Modifier } from './keyboard.ts';

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

/** One CDP command of a key press. */
export type CdpKeyCommand = CdpCommand<'Input.dispatchKeyEvent' | 'Input.cancelDragging'>;

/** What a Chromium key press needs to know about the keyboard before it: the modifiers held, the platform, and the keys CDP holds down. */
export interface ChromiumKeyboard {
  readonly held: ReadonlySet<Modifier>;
  /** Codes of the keys an earlier CDP key event holds down. */
  readonly pressed: ReadonlySet<string>;
  readonly mac: boolean;
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
  const { definition } = stroke;
  const { code } = definition;
  const modifiers = new Set<Modifier>([...keyboard.held, ...(stroke.phase === 'press' ? stroke.chord : [])]);
  const shifted = isShifted(stroke, keyboard.held.has('Shift'));
  const commands = keyboard.mac ? macEditingCommands(code, modifiers) : [];
  if (stroke.phase === 'keyUp' ? !keyboard.pressed.has(code) : keyValue(definition, shifted) !== undefined && commands.length === 0) return undefined;
  const key = shifted && definition.shiftKey !== undefined ? definition.shiftKey : definition.key;
  const keyCode = shifted && definition.shiftKeyCode !== undefined ? definition.shiftKeyCode : definition.keyCode;
  const typesText = [...key].length === 1 && !modifiers.has('Control') && !modifiers.has('Alt') && !modifiers.has('Meta');
  const event = { windowsVirtualKeyCode: keyCode, code, key, location: definition.location, isKeypad: definition.location === 3 };
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
  const { code, keyCode, key, location } = MODIFIER_KEYS[modifier];
  return { method: 'Input.dispatchKeyEvent', params: { type, windowsVirtualKeyCode: keyCode, code, key, location, isKeypad: false, modifiers: mask(holding) } };
}

/** Whether a CDP key command holds `code` down after it (true), releases it (false), or leaves it (undefined). */
export function holdsAfter(command: CdpKeyCommand): { code: string; down: boolean } | undefined {
  if (command.method !== 'Input.dispatchKeyEvent') return undefined;
  const { type, code } = command.params as { type: string; code: string };
  return { code, down: type !== 'keyUp' };
}
