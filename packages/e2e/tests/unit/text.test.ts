import { describe, expect, it } from 'vitest';
import {
  containsText,
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

describe('containsText', () => {
  it('exact string uses case-sensitive substring', () => {
    expect(containsText('Hello World', { kind: 'string', value: 'World', exact: true })).toBe(true);
    expect(containsText('Hello World', { kind: 'string', value: 'world', exact: true })).toBe(false);
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
});

describe('normalizeRegexpFlags', () => {
  it('sorts into canonical d,g,i,m,s,u,v,y order and de-duplicates', () => {
    expect(normalizeRegexpFlags('gid')).toBe('dgi');
    expect(normalizeRegexpFlags('yusmig')).toBe('gimsuy');
  });
});
