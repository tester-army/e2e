import { describe, expect, it } from 'vitest';
import { parseKey } from '../../src/keys.ts';

describe('parseKey', () => {
  it('translates named keys and single characters', () => {
    expect(parseKey('Enter')).toEqual({ key: 'return', modifiers: [] });
    expect(parseKey('Escape')).toEqual({ key: 'escape', modifiers: [] });
    expect(parseKey('ArrowDown')).toEqual({ key: 'down', modifiers: [] });
    expect(parseKey('Backspace')).toEqual({ key: 'delete', modifiers: [] });
    expect(parseKey('F5')).toEqual({ key: 'f5', modifiers: [] });
    expect(parseKey('a')).toEqual({ key: 'a', modifiers: [] });
    expect(parseKey(' ')).toEqual({ key: 'space', modifiers: [] });
    expect(parseKey('+')).toEqual({ key: '+', modifiers: [] });
  });

  it('parses chords into Cua Driver modifier names', () => {
    expect(parseKey('Meta+Shift+k')).toEqual({ key: 'k', modifiers: ['cmd', 'shift'] });
    expect(parseKey('Control+Alt+Delete')).toEqual({ key: 'forwarddelete', modifiers: ['ctrl', 'option'] });
    expect(parseKey('Shift+Tab')).toEqual({ key: 'tab', modifiers: ['shift'] });
  });

  it('refuses keys the driver has no name for', () => {
    expect(() => parseKey('PrintScreen')).toThrow(/no key named/);
    expect(() => parseKey('Meta+a+b')).toThrow(/exactly one/);
    expect(() => parseKey('Meta+')).toThrow(/no key to press|no key named/);
  });
});
