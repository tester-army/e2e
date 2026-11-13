import { describe, expect, it } from 'vitest';
import { testPattern } from 'e2e-core/lib/internal/regexp';

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
