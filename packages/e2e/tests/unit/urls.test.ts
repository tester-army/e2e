import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  normalizeBaseUrl,
  resolveNavigationUrl,
  urlMatches,
} from '../../src/internal/urls.ts';

describe('normalizeBaseUrl', () => {
  it('normalizes default ports, dot segments, and IDNA hosts', () => {
    expect(normalizeBaseUrl('https://EXAMPLE.test:443/a/../b').href).toBe('https://example.test/b');
    expect(normalizeBaseUrl('http://localhost:3000').origin).toBe('http://localhost:3000');
  });

  it('rejects userinfo, query, and fragment', () => {
    expect(() => normalizeBaseUrl('https://user:pw@example.test')).toThrow(/userinfo/);
    expect(() => normalizeBaseUrl('https://example.test/?q=1')).toThrow(/query/);
    expect(() => normalizeBaseUrl('https://example.test/#frag')).toThrow(/fragment/);
  });

  it('rejects plain HTTP for non-loopback hosts', () => {
    expect(() => normalizeBaseUrl('http://example.test')).toThrow(/loopback/);
    expect(normalizeBaseUrl('http://127.0.0.1:8080').origin).toBe('http://127.0.0.1:8080');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeBaseUrl('file:///tmp/app')).toThrow();
  });
});

describe('isLoopbackHost', () => {
  it('accepts localhost, *.localhost, 127.0.0.0/8, and ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('example.test')).toBe(false);
  });
});

describe('resolveNavigationUrl', () => {
  const base = normalizeBaseUrl('http://localhost:3000/app/');
  const allowed = ['http://localhost:3000'];

  it('resolves relative paths against the base', () => {
    expect(resolveNavigationUrl('/billing', base, allowed).url).toBe(
      'http://localhost:3000/billing',
    );
    expect(resolveNavigationUrl('settings', base, allowed).url).toBe(
      'http://localhost:3000/app/settings',
    );
  });

  it('denies origins outside the allowlist', () => {
    expect(() => resolveNavigationUrl('https://evil.test/x', base, allowed)).toThrow(
      /allowedOrigins/,
    );
  });

  it('always denies file:, data:, and javascript:', () => {
    expect(() => resolveNavigationUrl('file:///etc/passwd', base, allowed)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('data:text/html,x', base, allowed)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('javascript:alert(1)', base, allowed)).toThrow(/scheme/);
  });
});

describe('urlMatches', () => {
  const base = normalizeBaseUrl('http://localhost:3000');

  it('resolves relative expected strings against the base URL', () => {
    expect(urlMatches('http://localhost:3000/billing', '/billing', base.href)).toBe(true);
  });

  it('compares exactly after WHATWG serialization', () => {
    expect(urlMatches('http://localhost:3000/a', 'http://localhost:3000/a/../a', base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/a?x=1', '/a', base.href)).toBe(false);
  });

  it('tests regexps against the complete serialized URL', () => {
    expect(urlMatches('http://localhost:3000/beta/board', /beta/, base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/alpha', /beta/, base.href)).toBe(false);
  });
});
