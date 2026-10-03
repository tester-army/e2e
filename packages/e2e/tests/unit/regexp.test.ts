import { describe, expect, it } from 'vitest';
import { testPattern } from '../../src/internal/regexp.ts';

describe('testPattern', () => {
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
