import { describe, expect, it } from 'vitest';
import { escapeRegexpChar, testPattern } from '../../src/internal/regexp.ts';

describe('escapeRegexpChar', () => {
  it('leaves word characters, digits, underscore, and hyphen untouched', () => {
    for (const ch of ['a', 'Z', '0', '9', '_', '-']) {
      expect(escapeRegexpChar(ch)).toBe(ch);
    }
  });

  it('escapes regexp metacharacters and other symbols', () => {
    for (const ch of ['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/']) {
      expect(escapeRegexpChar(ch)).toBe(`\\${ch}`);
    }
  });

  it('produces sources that match the literal character', () => {
    for (const ch of ['.', '*', '$', 'a', '-']) {
      expect(new RegExp(`^${escapeRegexpChar(ch)}$`).test(ch)).toBe(true);
    }
    expect(new RegExp(`^${escapeRegexpChar('.')}$`).test('x')).toBe(false);
  });
});

describe('testPattern', () => {
  it('matches source and flags against input', () => {
    expect(testPattern('^abc$', '', 'abc')).toBe(true);
    expect(testPattern('^abc$', '', 'ABC')).toBe(false);
    expect(testPattern('^abc$', 'i', 'ABC')).toBe(true);
  });

  it('never leaks lastIndex state between calls with global or sticky flags', () => {
    expect(testPattern('a', 'g', 'a')).toBe(true);
    expect(testPattern('a', 'g', 'a')).toBe(true);
    expect(testPattern('^a', 'y', 'a')).toBe(true);
    expect(testPattern('^a', 'y', 'a')).toBe(true);
  });

  it('throws on invalid pattern sources', () => {
    expect(() => testPattern('(', '', 'x')).toThrow(SyntaxError);
  });
});
