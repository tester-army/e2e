/** The one US layout both key grammars read: every printable character, the WebDriver values a key sends with Shift held or not, and the code each value presses. */

import { describe, expect, it } from 'vitest';
import { codeOfValue, fixtureKeyStroke, KEYS, keyValue, pressStroke, strokeSource } from '../../src/bidi/keyboard.ts';

/** The value the key down of `source` sends. */
function pressed(source: ReturnType<typeof strokeSource>): string | undefined {
  const down = source.actions.findLast((action) => action.type === 'keyDown');
  return down?.type === 'keyDown' ? down.value : undefined;
}

describe('the US layout', () => {
  it('types every printable ASCII character as itself, by either grammar', () => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const character = String.fromCharCode(code);
      expect(pressed(strokeSource(fixtureKeyStroke(character, 'press'), false)), character).toBe(character);
      expect(pressed(strokeSource(pressStroke(character), false)), character).toBe(character);
    }
  });

  it('shifts a key code and an unshifted character while Shift is held, and leaves a shifted character as it is', () => {
    expect(pressed(strokeSource(pressStroke('Shift+1'), false))).toBe('!');
    expect(pressed(strokeSource(pressStroke('Shift+a'), false))).toBe('A');
    expect(pressed(strokeSource(fixtureKeyStroke('Shift+1', 'press'), false))).toBe('!');
    expect(pressed(strokeSource(fixtureKeyStroke('Digit1', 'press'), true))).toBe('!');
    expect(pressed(strokeSource(fixtureKeyStroke('1', 'keyDown'), true))).toBe('!');
    expect(pressed(strokeSource(fixtureKeyStroke('!', 'press'), false))).toBe('!');
    expect(pressed(strokeSource(fixtureKeyStroke('A', 'press'), false))).toBe('A');
    expect(pressed(strokeSource(fixtureKeyStroke('A', 'press'), true))).toBe('A');
  });

  it('reads a character as a key of the main block, never the numpad', () => {
    expect(fixtureKeyStroke('*', 'press').definition.code).toBe('Digit8');
    expect(fixtureKeyStroke('-', 'press').definition.code).toBe('Minus');
    expect(fixtureKeyStroke('NumpadSubtract', 'press').definition.code).toBe('NumpadSubtract');
    expect(fixtureKeyStroke('\n', 'press').definition.code).toBe('Enter');
  });

  it('maps every value it sends back to the key that sends it', () => {
    for (const definition of KEYS.values()) {
      for (const shifted of [false, true]) {
        const value = keyValue(definition, shifted);
        if (value === undefined) continue;
        expect(codeOfValue(value), definition.code).toBe(definition.code);
      }
    }
    expect(codeOfValue('A')).toBe('KeyA');
    expect(codeOfValue('a')).toBe('KeyA');
    expect(codeOfValue('!')).toBe('Digit1');
    expect(codeOfValue('')).toBe('ShiftLeft');
    expect(codeOfValue('')).toBe('ShiftRight');
    expect(codeOfValue('')).toBe('NumpadEnter');
  });

  it('refuses a key off the layout in either grammar, with that grammar\'s error', () => {
    expect(() => pressStroke('é')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: 'Unknown key: "é"' }));
    expect(() => fixtureKeyStroke('é', 'press')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'Unknown key: "é"' }));
  });

  it('presses a chord\'s modifiers around the key with their left-hand values', () => {
    expect(strokeSource(fixtureKeyStroke('Control+Shift+KeyZ', 'press'), false).actions.map((action) => (action.type === 'pause' ? '' : `${action.type}:${action.value}`))).toEqual([
      'keyDown:',
      'keyDown:',
      'keyDown:Z',
      'keyUp:Z',
      'keyUp:',
      'keyUp:',
    ]);
  });
});
