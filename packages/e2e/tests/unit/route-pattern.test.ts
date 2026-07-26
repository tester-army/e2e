import { describe, expect, it } from 'vitest';
import {
  compileRoutePattern,
  routePatternMatches,
  routePatternsEqual,
  toRoutePattern,
} from '../../src/internal/route-pattern.ts';

function matches(pattern: string, url: string): boolean {
  return compileRoutePattern(pattern).test(url);
}

describe('route pattern grammar', () => {
  it('* matches within one path segment', () => {
    expect(matches('http://x.test/api/*', 'http://x.test/api/flags')).toBe(true);
    expect(matches('http://x.test/api/*', 'http://x.test/api/a/b')).toBe(false);
  });

  it('** crosses /', () => {
    expect(matches('**/api/flags', 'http://x.test/api/flags')).toBe(true);
    expect(matches('http://x.test/**', 'http://x.test/a/b/c')).toBe(true);
  });

  it('? matches one character', () => {
    expect(matches('http://x.test/v?', 'http://x.test/v1')).toBe(true);
    expect(matches('http://x.test/v?', 'http://x.test/v12')).toBe(false);
  });

  it('backslash escapes the next character', () => {
    expect(matches('http://x.test/a\\*b', 'http://x.test/a*b')).toBe(true);
    expect(matches('http://x.test/a\\*b', 'http://x.test/axb')).toBe(false);
  });

  it('other characters are literal, including dots', () => {
    expect(matches('http://x.test/a.b', 'http://x.test/a.b')).toBe(true);
    expect(matches('http://x.test/a.b', 'http://x.test/aXb')).toBe(false);
  });

  it('matches the complete URL, not a substring', () => {
    expect(matches('/api/flags', 'http://x.test/api/flags')).toBe(false);
  });
});

describe('routePatternMatches', () => {
  it('supports regexp wire patterns', () => {
    expect(
      routePatternMatches({ kind: 'regexp', source: 'api/\\w+$', flags: '' }, 'http://x.test/api/flags'),
    ).toBe(true);
  });
});

describe('routePatternsEqual', () => {
  it('compares string and regexp forms structurally', () => {
    expect(routePatternsEqual(toRoutePattern('**/a'), toRoutePattern('**/a'))).toBe(true);
    expect(routePatternsEqual(toRoutePattern(/a/i), toRoutePattern(/a/i))).toBe(true);
    expect(routePatternsEqual(toRoutePattern(/a/i), toRoutePattern(/a/g))).toBe(false);
    expect(routePatternsEqual(toRoutePattern('a'), toRoutePattern(/a/))).toBe(false);
  });
});
