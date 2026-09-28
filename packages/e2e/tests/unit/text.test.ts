import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  compareText,
  matchesText,
  normalizeRegexpFlags,
  normalizeText,
  toTextPattern,
} from '../../src/internal/text.ts';

describe('normalizeText', () => {
  it('trims and collapses unicode whitespace runs to one ASCII space', () => {
    expect(normalizeText('  a \t\n b\u00a0c ')).toBe('a b c');
    expect(normalizeText('\u2003x\u2003')).toBe('x');
  });
});

describe('matchesText', () => {
  it('string matching is exact by default', () => {
    expect(matchesText('Sign in', { kind: 'string', value: 'Sign in', exact: true })).toBe(true);
    expect(matchesText('Sign in now', { kind: 'string', value: 'Sign in', exact: true })).toBe(false);
  });

  it('exact matching still normalizes whitespace on both sides', () => {
    expect(matchesText('  Sign\n in ', { kind: 'string', value: 'Sign in', exact: true })).toBe(true);
  });

  it('exact:false is case-insensitive substring matching', () => {
    expect(matchesText('Sign In Now', { kind: 'string', value: 'sign in', exact: false })).toBe(true);
    expect(matchesText('Sign In Now', { kind: 'string', value: 'log in', exact: false })).toBe(false);
  });

  it('regexps use ECMAScript semantics and ignore exact', () => {
    expect(matchesText('Order #42', { kind: 'regexp', source: '#\\d+', flags: '' })).toBe(true);
  });

  it('resets global regexp state between matches', () => {
    const pattern = { kind: 'regexp', source: 'a', flags: 'g' } as const;
    expect(matchesText('a', pattern)).toBe(true);
    expect(matchesText('a', pattern)).toBe(true);
    expect(matchesText('a', pattern)).toBe(true);
  });
});

describe('compareText', () => {
  const contains = { mode: 'contains', normalize: true } as const;
  const raw = { mode: 'equals', normalize: false } as const;

  it('contains mode uses a case-sensitive substring for an exact string', () => {
    expect(compareText('Hello World', { kind: 'string', value: 'World', exact: true }, contains)).toBe(true);
    expect(compareText('Hello World', { kind: 'string', value: 'world', exact: true }, contains)).toBe(false);
  });

  it('normalize: false compares the raw strings, newlines and trailing spaces included', () => {
    const value = 'line1\n\nline2  ';
    expect(compareText(value, { kind: 'string', value: 'line1 line2', exact: true }, raw)).toBe(false);
    expect(compareText(value, { kind: 'string', value, exact: true }, raw)).toBe(true);
    expect(compareText(value, { kind: 'regexp', source: '^line1\\n\\nline2 {2}$', flags: '' }, raw)).toBe(true);
    expect(compareText(value, { kind: 'string', value: 'line1 line2', exact: true }, { ...raw, normalize: true })).toBe(true);
  });
});

describe('toTextPattern', () => {
  it('defaults strings to exact', () => {
    expect(toTextPattern('x')).toEqual({ kind: 'string', value: 'x', exact: true });
    expect(toTextPattern('x', { exact: false })).toEqual({ kind: 'string', value: 'x', exact: false });
  });

  it('serializes regexps with normalized flags', () => {
    expect(toTextPattern(/ab/gi)).toEqual({ kind: 'regexp', source: 'ab', flags: 'gi' });
  });

  it('accepts a RegExp from another realm', () => {
    expect(toTextPattern(runInNewContext('/ab/i') as RegExp)).toEqual({ kind: 'regexp', source: 'ab', flags: 'i' });
  });

  it('rejects anything but a string or a RegExp instead of matching everything', () => {
    for (const match of [(text: string) => text === 'x', { source: 'x', flags: '' }, undefined, null, 1]) {
      expect(() => toTextPattern(match as unknown as RegExp)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('string or RegExp') }),
      );
    }
  });
});

describe('normalizeRegexpFlags', () => {
  it('sorts into canonical d,g,i,m,s,u,v,y order and de-duplicates', () => {
    expect(normalizeRegexpFlags('gid')).toBe('dgi');
    expect(normalizeRegexpFlags('yusmig')).toBe('gimsuy');
  });
});
