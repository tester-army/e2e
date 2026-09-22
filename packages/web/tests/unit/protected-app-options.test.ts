/**
 * The `headers`, `basicAuth`, `cookies`, and `testIdAttribute` options are
 * checked at config load, so a header the browser could never send, a cookie
 * it could not scope, or an attribute no element could carry fails the run
 * before a browser launches. What the browser does with valid ones is in
 * tests/integration.
 */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';

describe('web({ headers })', () => {
  it('accepts an object of header names to string values', () => {
    expect(() =>
      web({ headers: { 'x-vercel-protection-bypass': 'token', 'ngrok-skip-browser-warning': '1' } }),
    ).not.toThrow();
    expect(() => web({ headers: {} })).not.toThrow();
  });

  it('rejects a header name outside the token grammar as INVALID_CONFIG', () => {
    for (const name of ['x bypass', 'x:bypass', '', 'x\nbypass']) {
      expect(() => web({ headers: { [name]: 'v' } })).toThrowError(/invalid header name/);
    }
  });

  it('rejects a value that is not a string or carries a control character, tab excepted', () => {
    expect(() => web({ headers: { 'x-a': 1 as unknown as string } })).toThrowError(/must be a string/);
    expect(() => web({ headers: { 'x-a': 'v\r\nx-b: injected' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': 'token\u0000suffix' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': '\u007f' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': 'a\tb' } })).not.toThrow();
  });

  it('rejects headers that are not a plain object, null included', () => {
    for (const headers of [['x-a'], null, 'x-a: v', 3]) {
      expect(() => web({ headers: headers as unknown as Record<string, string> })).toThrowError(
        /must be an object/,
      );
    }
  });
});

describe('web({ basicAuth })', () => {
  it('accepts a username and password', () => {
    expect(() => web({ basicAuth: { username: 'ada', password: '' } })).not.toThrow();
  });

  it('rejects credentials that are not a plain object, null included', () => {
    for (const basicAuth of [null, ['ada', 'x'], 'ada:x']) {
      expect(() =>
        web({ basicAuth: basicAuth as unknown as { username: string; password: string } }),
      ).toThrowError(/must be an object/);
    }
  });

  it('rejects a missing or colon-bearing username and a non-string password', () => {
    expect(() => web({ basicAuth: { username: '', password: 'x' } })).toThrowError(/non-empty username/);
    expect(() => web({ basicAuth: { username: 'ada:x', password: 'x' } })).toThrowError(/":"/);
    expect(() =>
      web({ basicAuth: { username: 'ada', password: undefined as unknown as string } }),
    ).toThrowError(/password string/);
  });
});

describe('web({ cookies })', () => {
  it('accepts the web.setCookies shape, with or without a url', () => {
    expect(() =>
      web({
        url: 'http://127.0.0.1:3000',
        cookies: [
          { name: 'om_demo_notice_ack', value: 'ack', sameSite: 'Lax' },
          { url: 'https://staging.example.test/app', name: 'consent', value: '1', secure: true, httpOnly: true, expires: 4_102_444_800 },
          { domain: '.example.test', path: '/', name: 'tz', value: 'UTC' },
        ],
      }),
    ).not.toThrow();
    expect(() => web({ cookies: [] })).not.toThrow();
    // A schemeless app url takes the harness's scheme rule, so the default target still resolves.
    expect(() => web({ url: 'localhost:3000', cookies: [{ name: 'ack', value: '1' }] })).not.toThrow();
    expect(() => web({ url: 'staging.example.test', cookies: [{ name: 'ack', value: '1' }] })).not.toThrow();
    expect(() => web({ url: 'http://127.0.0.1:0', cookies: [{ name: 'ack', value: '1' }] })).not.toThrow();
  });

  it('rejects cookies that are not an array of objects as INVALID_CONFIG', () => {
    for (const cookies of [null, {}, 'ack=1', 3]) {
      expect(() => web({ cookies: cookies as unknown as [] })).toThrowError(/cookies.*must be an array/);
    }
    for (const cookie of [null, 'ack=1', ['ack', '1']]) {
      expect(() => web({ cookies: [cookie as unknown as { name: string; value: string }] })).toThrowError(
        /entry 0 must be an object/,
      );
    }
  });

  it('rejects a name or value the Cookie header could not carry', () => {
    for (const name of ['', 'a b', 'a=b', 'a;b', 'a\nb', 3]) {
      expect(() => web({ cookies: [{ url: 'http://127.0.0.1', name: name as string, value: '1' }] })).toThrowError(
        /requires a non-empty cookie name/,
      );
    }
    for (const value of ['a;b', 'a\u0000b', 1]) {
      expect(() => web({ cookies: [{ url: 'http://127.0.0.1', name: 'ack', value: value as string }] })).toThrowError(
        /cookie "ack" requires a value string/,
      );
    }
  });

  it('rejects a target the browser could not scope the cookie by', () => {
    const cookie = (target: Record<string, unknown>) =>
      web({ cookies: [{ name: 'ack', value: '1', ...target } as unknown as { name: string; value: string; url: string }] });
    expect(() => cookie({ url: 'http://127.0.0.1', domain: '127.0.0.1' })).toThrowError(/url or domain, not both/);
    expect(() => cookie({ url: 'not a url' })).toThrowError(/absolute http\(s\) URL/);
    expect(() => cookie({ url: 'file:///tmp/app' })).toThrowError(/absolute http\(s\) URL/);
    expect(() => cookie({ url: 'http://127.0.0.1', path: '/' })).toThrowError(/path applies to a domain cookie/);
    expect(() => cookie({ domain: '' })).toThrowError(/domain must be a host name/);
    expect(() => cookie({})).toThrowError(/target has no url to default to/);
  });

  it('rejects attribute values outside their type', () => {
    const base = { url: 'http://127.0.0.1', name: 'ack', value: '1' } as const;
    expect(() => web({ cookies: [{ ...base, expires: Number.NaN }] })).toThrowError(/expires must be a finite number/);
    expect(() => web({ cookies: [{ ...base, httpOnly: 'yes' as unknown as boolean }] })).toThrowError(/httpOnly must be a boolean/);
    expect(() => web({ cookies: [{ ...base, secure: 1 as unknown as boolean }] })).toThrowError(/secure must be a boolean/);
    expect(() => web({ cookies: [{ ...base, sameSite: 'lax' as unknown as 'Lax' }] })).toThrowError(/sameSite must be/);
  });
});

describe('web({ testIdAttribute })', () => {
  it('accepts an attribute name', () => {
    for (const attribute of ['data-testid', 'data-qa', 'data-test-id', 'id', 'x:qa', 'data.qa']) {
      expect(() => web({ testIdAttribute: attribute })).not.toThrow();
    }
  });

  it('rejects anything that is not an attribute name as INVALID_CONFIG', () => {
    for (const attribute of ['', ' data-qa', 'data qa', '1-qa', 'data="qa"', 'data-qa]', 3, null]) {
      expect(() => web({ testIdAttribute: attribute as unknown as string })).toThrowError(
        /testIdAttribute.*must be an attribute name/,
      );
    }
  });
});
