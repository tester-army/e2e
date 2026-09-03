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
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow(/must be http\(s\)/);
    // A single-slash scheme is still a scheme, never a host named after it.
    expect(() => normalizeBaseUrl('file:/tmp/app')).toThrow(/must be http\(s\)/);
    expect(() => normalizeBaseUrl('ftp:/server/path')).toThrow(/must be http\(s\)/);
    expect(() => normalizeBaseUrl('data:text/html,hi')).toThrow(/must be http\(s\)/);
  });

  it('infers https for a schemeless host and http for a schemeless loopback host', () => {
    expect(normalizeBaseUrl('tester.army').href).toBe('https://tester.army/');
    expect(normalizeBaseUrl('www.tester.army/app').href).toBe('https://www.tester.army/app');
    expect(normalizeBaseUrl('localhost:3000').origin).toBe('http://localhost:3000');
    expect(normalizeBaseUrl('localhost:3000/app').href).toBe('http://localhost:3000/app');
    expect(normalizeBaseUrl('app.test:8443').origin).toBe('https://app.test:8443');
    expect(normalizeBaseUrl('http:/localhost:3000').origin).toBe('http://localhost:3000');
    expect(normalizeBaseUrl('127.0.0.1:8080/base/').basePath).toBe('/base/');
    expect(normalizeBaseUrl('[::1]:4000').origin).toBe('http://[::1]:4000');
    expect(() => normalizeBaseUrl('tester.army?q=1')).toThrow(/query/);
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
