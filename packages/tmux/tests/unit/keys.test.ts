import { describe, expect, it } from 'vitest';
import { BackendError } from '@e2edev/e2e/backend';
import { keyArgs } from '../../src/keys.ts';

describe('keyArgs', () => {
  it('sends a plain character literally, so tmux syntax characters are text', () => {
    expect(keyArgs('a')).toEqual(['-l', '--', 'a']);
    expect(keyArgs(';')).toEqual(['-l', '--', ';']);
    expect(keyArgs('-')).toEqual(['-l', '--', '-']);
    expect(keyArgs('/')).toEqual(['-l', '--', '/']);
  });

  it('maps browser key names onto tmux names, case-insensitively', () => {
    expect(keyArgs('Enter')).toEqual(['Enter']);
    expect(keyArgs('Return')).toEqual(['Enter']);
    expect(keyArgs('escape')).toEqual(['Escape']);
    expect(keyArgs('ArrowDown')).toEqual(['Down']);
    expect(keyArgs('ArrowLeft')).toEqual(['Left']);
    expect(keyArgs('Backspace')).toEqual(['BSpace']);
    expect(keyArgs('Delete')).toEqual(['DC']);
    expect(keyArgs('PageDown')).toEqual(['NPage']);
    expect(keyArgs('PageUp')).toEqual(['PPage']);
    expect(keyArgs('Space')).toEqual(['Space']);
    expect(keyArgs('F5')).toEqual(['F5']);
  });

  it('builds chords in tmux modifier order', () => {
    expect(keyArgs('Control+C')).toEqual(['C-c']);
    expect(keyArgs('ctrl+c')).toEqual(['C-c']);
    expect(keyArgs('Alt+x')).toEqual(['M-x']);
    expect(keyArgs('Meta+Enter')).toEqual(['M-Enter']);
    expect(keyArgs('Alt+Control+Left')).toEqual(['C-M-Left']);
    expect(keyArgs('Shift+Tab')).toEqual(['BTab']);
    expect(keyArgs('Shift+a')).toEqual(['-l', '--', 'A']);
    expect(keyArgs('Control+Shift+a')).toEqual(['C-A']);
    expect(keyArgs('Shift++')).toEqual(['-l', '--', '+']);
  });

  it('passes a native tmux chord through untouched', () => {
    expect(keyArgs('C-c')).toEqual(['C-c']);
    expect(keyArgs('M-x')).toEqual(['M-x']);
    expect(keyArgs('C-M-Up')).toEqual(['C-M-Up']);
  });

  it('refuses an empty or unknown key with UNSUPPORTED_CAPABILITY', () => {
    for (const key of ['', '  ', 'Hyper+x', 'Bogus']) {
      let caught: unknown;
      try {
        keyArgs(key);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackendError);
      expect((caught as BackendError).code).toBe('UNSUPPORTED_CAPABILITY');
    }
  });
});
