/** Configured cookies are checked at config load, so a bad shape never waits for the first attempt to fail. */

import { describe, expect, it } from 'vitest';
import { configuredCookies } from '../../src/cookies.ts';

const app = 'http://localhost:3000';

describe('configuredCookies', () => {
  it('accepts a url cookie, a domain cookie with a path, and a cookie that defaults to the app url', () => {
    expect(configuredCookies([{ name: 'a', value: '1', url: 'https://app.example.test/x' }], app)).toEqual([{ name: 'a', value: '1', url: 'https://app.example.test/x' }]);
    expect(configuredCookies([{ name: 'a', value: '1', domain: '.example.test', path: '/shop' }], app)).toEqual([{ name: 'a', value: '1', domain: '.example.test', path: '/shop' }]);
    expect(configuredCookies([{ name: 'a', value: '1' }], app)).toEqual([{ name: 'a', value: '1', url: 'http://localhost:3000/' }]);
  });

  it('rejects a domain that is not a host name, at config load', () => {
    for (const domain of ['https://example.test', 'example.test:3000', 'example.test/shop', 'exa mple.test', '']) {
      expect(() => configuredCookies([{ name: 'a', value: '1', domain }], app)).toThrow(/domain must be a host name/);
    }
  });

  it('rejects a path that does not start with a slash or carries a separator', () => {
    for (const path of ['shop', ';/shop', '/shop;x', '/a\u0000b']) {
      expect(() => configuredCookies([{ name: 'a', value: '1', domain: 'example.test', path }], app)).toThrow(/path must start with/);
    }
  });
});
