/** Which keys Chromium takes as CDP key events, and the events: media keys, Numpad5 with NumLock off, and macOS editing shortcuts with their commands. */

import { describe, expect, it } from 'vitest';
import { chromiumKeyCommands, lacksWebDriverValue, MAC_EDITING_COMMANDS, macEditingCommands, type ChromiumKeyboard, type Modifier } from '../../src/bidi/chromium-keys.ts';
import { fixtureKeySource, fixtureKeyStroke } from '../../src/bidi/input.ts';

/** A keyboard with `held` modifiers down and nothing else, on macOS or not. */
function keyboard(mac: boolean, held: Modifier[] = [], pressed: string[] = []): ChromiumKeyboard {
  return { held: new Set(held), pressed: new Set(pressed), mac };
}

describe('MAC_EDITING_COMMANDS', () => {
  it('names each shortcut with its modifiers in Shift, Control, Alt, Meta order and drops the commands that insert text', () => {
    for (const [shortcut, commands] of Object.entries(MAC_EDITING_COMMANDS)) {
      const modifiers = shortcut.split('+').slice(0, -1);
      expect(modifiers).toEqual(['Shift', 'Control', 'Alt', 'Meta'].filter((modifier) => modifiers.includes(modifier)));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command).toMatch(/^(?!insert)[a-z][A-Za-z]*$/);
    }
    expect(MAC_EDITING_COMMANDS['Enter']).toBeUndefined();
    expect(MAC_EDITING_COMMANDS['Control+KeyO']).toEqual(['moveBackward']);
  });

  it('has a key definition for every code it binds', () => {
    for (const shortcut of Object.keys(MAC_EDITING_COMMANDS)) {
      const parts = shortcut.split('+');
      const stroke = { name: parts.at(-1)!, phase: 'keyDown' as const, chord: [] };
      expect(chromiumKeyCommands(stroke, keyboard(true, parts.slice(0, -1) as Modifier[])), shortcut).toBeDefined();
    }
  });

  it('looks a shortcut up whatever order its modifiers are held in', () => {
    expect(macEditingCommands('KeyB', new Set(['Alt', 'Shift', 'Control']))).toEqual(['moveWordBackwardAndModifySelection']);
    expect(macEditingCommands('KeyB', new Set())).toEqual([]);
  });
});

describe('chromiumKeyCommands', () => {
  it('leaves to BiDi a key WebDriver presses the same way', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('KeyB', 'press'), keyboard(false))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Backspace', 'press'), keyboard(false))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift', 'keyDown'), keyboard(true))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Enter', 'press'), keyboard(true))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift+Numpad5', 'press'), keyboard(false))).toBeUndefined();
  });

  it('presses a media key, which WebDriver has no value for, with no text', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('AudioVolumeMute', 'press'), keyboard(false))).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', windowsVirtualKeyCode: 173, code: 'AudioVolumeMute', key: 'AudioVolumeMute', location: 0, isKeypad: false, modifiers: 0, autoRepeat: false, commands: [] } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 173, code: 'AudioVolumeMute', key: 'AudioVolumeMute', location: 0, isKeypad: false, modifiers: 0 } },
    ]);
  });

  it('presses Numpad5 as Clear on the keypad with NumLock off', () => {
    const [down] = chromiumKeyCommands(fixtureKeyStroke('Numpad5', 'press'), keyboard(false))!;
    expect(down!.params).toMatchObject({ key: 'Clear', code: 'Numpad5', windowsVirtualKeyCode: 12, location: 3, isKeypad: true });
  });

  it('names the editing commands of a macOS shortcut and presses its modifiers around the key', () => {
    const commands = chromiumKeyCommands(fixtureKeyStroke('Shift+Control+Alt+KeyB', 'press'), keyboard(true))!;
    expect(commands.map(({ params }) => [params['type'], params['key'], params['modifiers']])).toEqual([
      ['rawKeyDown', 'Shift', 8],
      ['rawKeyDown', 'Control', 10],
      ['rawKeyDown', 'Alt', 11],
      ['rawKeyDown', 'B', 11],
      ['keyUp', 'B', 11],
      ['keyUp', 'Alt', 10],
      ['keyUp', 'Control', 8],
      ['keyUp', 'Shift', 0],
    ]);
    expect(commands[3]!.params['commands']).toEqual(['moveWordBackwardAndModifySelection']);
  });

  it('counts modifiers BiDi holds, without pressing them again', () => {
    const commands = chromiumKeyCommands(fixtureKeyStroke('Shift+ArrowUp', 'press'), keyboard(true, ['Shift', 'Meta']))!;
    expect(commands.map(({ params }) => params['key'])).toEqual(['ArrowUp', 'ArrowUp']);
    expect(commands[0]!.params).toMatchObject({ modifiers: 12, commands: ['moveToBeginningOfDocumentAndModifySelection'] });
  });

  it('types a letter of a shortcut only while no modifier but Shift is held', () => {
    const [down] = chromiumKeyCommands(fixtureKeyStroke('Meta+KeyA', 'press'), keyboard(true))!.slice(1);
    expect(down!.params).toMatchObject({ type: 'rawKeyDown', key: 'a', commands: ['selectAll'] });
    expect(down!.params['text']).toBeUndefined();
  });

  it('runs no macOS editing command off macOS', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift+Meta+ArrowUp', 'press'), keyboard(false))).toBeUndefined();
  });

  it('cancels a drag on Escape, as the mapper does', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('Escape', 'press'), keyboard(true))!.map(({ method }) => method)).toEqual(['Input.cancelDragging', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(chromiumKeyCommands(fixtureKeyStroke('Alt+Escape', 'press'), keyboard(true))!.map(({ method }) => method)).not.toContain('Input.cancelDragging');
  });

  it('holds a key through CDP, repeats it, and releases it there', () => {
    const down = chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyDown'), keyboard(true))!;
    expect(down.map(({ params }) => params['type'])).toEqual(['rawKeyDown']);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyDown'), keyboard(true, [], ['ArrowLeft']))![0]!.params['autoRepeat']).toBe(true);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyUp'), keyboard(true, [], ['ArrowLeft']))!.map(({ params }) => params['type'])).toEqual(['keyUp']);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyUp'), keyboard(true))).toBeUndefined();
  });
});

describe('numpad keys on BiDi', () => {
  it('presses the NumLock-off key without Shift and the digit with it', () => {
    expect(fixtureKeySource('NumpadDecimal', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '' });
    expect(fixtureKeySource('NumpadDecimal', 'press', true).actions[0]).toEqual({ type: 'keyDown', value: '' });
    expect(fixtureKeySource('Shift+Numpad1', 'press', false).actions[1]).toEqual({ type: 'keyDown', value: '' });
    expect(fixtureKeySource('Numpad1', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '' });
  });

  it('refuses a key WebDriver has no value for', () => {
    expect(lacksWebDriverValue('MediaPlayPause', false)).toBe(true);
    expect(lacksWebDriverValue('Numpad5', true)).toBe(false);
    expect(() => fixtureKeySource('MediaPlayPause', 'press', false)).toThrow('WebDriver defines no key value for "MediaPlayPause"');
    expect(() => fixtureKeySource('Numpad5', 'press', false)).toThrow('with NumLock off (Clear)');
  });
});
