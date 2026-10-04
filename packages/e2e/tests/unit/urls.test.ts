import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '../../src/internal/hosts.ts';
import {
  normalizeBaseUrl,
  portOf,
  requestsFreePort,
  resolveNavigationUrl,
  sameSite,
  siteOf,
  urlMatches,
} from '../../src/internal/urls.ts';

describe('base URL ports', () => {
  it('tells a free-port request from a fixed or default port', () => {
    const requested = normalizeBaseUrl('http://[::1]:0/app/');
    expect(requestsFreePort(requested)).toBe(true);
    expect(portOf(requested)).toBe(0);
    expect(requestsFreePort(normalizeBaseUrl('https://app.test'))).toBe(false);
    expect(portOf(normalizeBaseUrl('https://app.test'))).toBe(443);
    expect(portOf(normalizeBaseUrl('http://localhost:3000'))).toBe(3000);
  });
});

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

  it('accepts port 0 on a literal loopback address only, where the run picks a free port', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:0').origin).toBe('http://127.0.0.1:0');
    expect(normalizeBaseUrl('http://[::1]:0/app').href).toBe('http://[::1]:0/app');
    // A name may resolve to another address than the one the command binds.
    expect(() => normalizeBaseUrl('localhost:0/app')).toThrow(/port 0 .* 127\.0\.0\.1 or \[::1\]/);
    expect(() => normalizeBaseUrl('https://app.test:0')).toThrow(/port 0 .* 127\.0\.0\.1 or \[::1\]/);
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

  it('resolves relative paths against the base', () => {
    expect(resolveNavigationUrl('/billing', base).url).toBe('http://localhost:3000/billing');
    expect(resolveNavigationUrl('settings', base).url).toBe('http://localhost:3000/app/settings');
  });

  it('admits any http(s) origin: a click reaches one just as well', () => {
    expect(resolveNavigationUrl('https://other.test/x', base).url).toBe('https://other.test/x');
  });

  it('always denies file:, data:, and javascript:', () => {
    expect(() => resolveNavigationUrl('file:///etc/passwd', base)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('data:text/html,x', base)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('javascript:alert(1)', base)).toThrow(/scheme/);
  });

  it.each([
    ['view-source:file:///etc/passwd', 'view-source:'],
    ['view-source:http://localhost:3000/', 'view-source:'],
    ['VIEW-SOURCE:file:///etc/passwd', 'view-source:'],
    ['  view-source:file:///etc/passwd', 'view-source:'],
    ['\tview-source:file:///etc/passwd\n', 'view-source:'],
    ['view-\tsource:file:///etc/passwd', 'view-source:'],
    ['FiLe:///etc/passwd', 'file:'],
    [' file:///etc/passwd', 'file:'],
    ['blob:http://localhost:3000/0b7c4c1e', 'blob:'],
    ['filesystem:http://localhost:3000/temporary/x', 'filesystem:'],
    ['chrome://version', 'chrome:'],
    ['chrome-extension://abcdefghijklmnop/page.html', 'chrome-extension:'],
    ['devtools://devtools/bundled/inspector.html', 'devtools:'],
    ['about:blank#x', 'about:'],
    ['about:blank?x', 'about:'],
    ['about:srcdoc', 'about:'],
    ['about:version', 'about:'],
    ['ftp://example.test/x', 'ftp:'],
    ['ws://localhost:3000/socket', 'ws:'],
    ['myapp://orders/42', 'myapp:'],
  ])('denies %j: only http(s) is navigable', (input, scheme) => {
    expect(() => resolveNavigationUrl(input, base)).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED', message: `forbidden URL scheme: ${scheme}` }),
    );
    expect(() => resolveNavigationUrl(input, undefined)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('reads a percent-encoded scheme as a path, not a scheme', () => {
    expect(resolveNavigationUrl('view-source%3Afile:///etc/passwd', base).url).toBe('http://localhost:3000/app/view-source%3Afile:///etc/passwd');
    expect(resolveNavigationUrl('%66ile:///etc/passwd', base).url).toBe('http://localhost:3000/app/%66ile:///etc/passwd');
  });

  it('admits exactly about:blank, which loads nothing', () => {
    expect(resolveNavigationUrl('about:blank', base).url).toBe('about:blank');
    expect(resolveNavigationUrl(' ABOUT:blank ', undefined).url).toBe('about:blank');
  });

  it('admits http(s) in any case and with surrounding whitespace', () => {
    expect(resolveNavigationUrl('HTTPS://Other.test/x', base).url).toBe('https://other.test/x');
    expect(resolveNavigationUrl('  http://localhost:3000/a ', base).url).toBe('http://localhost:3000/a');
    expect(resolveNavigationUrl('//other.test/x', base).url).toBe('http://other.test/x');
  });
});

describe('siteOf and sameSite', () => {
  it('reads the registrable domain without a public suffix list', () => {
    expect(siteOf('tester.army')).toBe('tester.army');
    expect(siteOf('auth.tester.army')).toBe('tester.army');
    expect(siteOf('a.b.app.example.com')).toBe('example.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('example.co.uk')).toBe('example.co.uk');
    expect(siteOf('Example.COM')).toBe('example.com');
  });

  it('treats loopback names and IP literals as sites of their own', () => {
    expect(siteOf('localhost')).toBe('localhost');
    expect(siteOf('app.localhost')).toBe('app.localhost');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('[::1]')).toBe('[::1]');
  });

  it('compares a URL to a site by host alone, and puts an unparseable URL off every site', () => {
    expect(sameSite('https://auth.tester.army/login', 'tester.army')).toBe(true);
    expect(sameSite('http://127.0.0.1:4000/api', '127.0.0.1')).toBe(true);
    expect(sameSite('http://localhost:4000/', '127.0.0.1')).toBe(false);
    expect(sameSite('https://evil.test/', 'tester.army')).toBe(false);
    expect(sameSite('null', 'tester.army')).toBe(false);
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

  it('ignoreCase folds a string comparison and sets or clears the i flag of a regexp', () => {
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href)).toBe(false);
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href, true)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href, false)).toBe(false);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/, base.href, true)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/i, base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/i, base.href, false)).toBe(false);
  });

  it('rejects a predicate instead of matching every URL', () => {
    const predicate = ((url: URL) => url.pathname === '/other') as unknown as RegExp;
    expect(() => urlMatches('http://localhost:3000/items', predicate, base.href)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
