/**
 * The `headers` and `basicAuth` options are checked at config load, so a
 * header the browser could never send fails the run before a browser launches.
 * What the browser does with valid ones is in tests/integration.
 */

import { describe, expect, it } from 'vitest';
import { playwright } from '../../src/index.ts';

describe('playwright({ headers })', () => {
  it('accepts an object of header names to string values', () => {
    expect(() =>
      playwright({ headers: { 'x-vercel-protection-bypass': 'token', 'ngrok-skip-browser-warning': '1' } }),
    ).not.toThrow();
    expect(() => playwright({ headers: {} })).not.toThrow();
  });

  it('rejects a header name outside the token grammar as INVALID_CONFIG', () => {
    for (const name of ['x bypass', 'x:bypass', '', 'x\nbypass']) {
      expect(() => playwright({ headers: { [name]: 'v' } })).toThrowError(/invalid header name/);
    }
  });

  it('rejects a value that is not a string or carries a line break', () => {
    expect(() => playwright({ headers: { 'x-a': 1 as unknown as string } })).toThrowError(/must be a string/);
    expect(() => playwright({ headers: { 'x-a': 'v\r\nx-b: injected' } })).toThrowError(/line break/);
  });

  it('rejects headers that are not an object', () => {
    expect(() => playwright({ headers: ['x-a'] as unknown as Record<string, string> })).toThrowError(
      /must be an object/,
    );
  });
});

describe('playwright({ basicAuth })', () => {
  it('accepts a username and password', () => {
    expect(() => playwright({ basicAuth: { username: 'ada', password: '' } })).not.toThrow();
  });

  it('rejects a missing or colon-bearing username and a non-string password', () => {
    expect(() => playwright({ basicAuth: { username: '', password: 'x' } })).toThrowError(/non-empty username/);
    expect(() => playwright({ basicAuth: { username: 'ada:x', password: 'x' } })).toThrowError(/":"/);
    expect(() =>
      playwright({ basicAuth: { username: 'ada', password: undefined as unknown as string } }),
    ).toThrowError(/password string/);
  });
});
