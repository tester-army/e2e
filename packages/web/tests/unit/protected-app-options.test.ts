/**
 * The `headers`, `basicAuth`, and `testIdAttribute` options are checked at
 * config load, so a header the browser could never send or an attribute no
 * element could carry fails the run before a browser launches. What the
 * browser does with valid ones is in tests/integration.
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
