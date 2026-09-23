/**
 * What the engine hands the harness for redaction: the gate credentials every
 * request carries, and the cookies and storage a session snapshot restores,
 * each above the length below which a value is a word rather than a token.
 */

import { describe, expect, it } from 'vitest';
import { registerGateSecrets, registerStateSecrets } from '../../src/session-secrets.ts';

function collecting() {
  const seen: [string, string][] = [];
  return { seen, register: (name: string, value: string) => { seen.push([name, value]); } };
}

/** The floor the security docs promise: a value this long is a token, one shorter is a word. */
const DOCUMENTED_FLOOR = 16;
const TOKEN = 'a'.repeat(DOCUMENTED_FLOOR);

describe('registerGateSecrets', () => {
  it('registers header values long enough to be tokens under header.<name>, and skips the short ones', () => {
    const { seen, register } = collecting();
    registerGateSecrets(register, { 'x-vercel-protection-bypass': TOKEN, 'ngrok-skip-browser-warning': 'true' }, undefined);
    expect(seen).toEqual([['header.x-vercel-protection-bypass', TOKEN]]);
  });

  it('registers the basic-auth password whatever its length, never the user name', () => {
    const { seen, register } = collecting();
    registerGateSecrets(register, undefined, { username: 'preview', password: 'pw' });
    expect(seen).toEqual([['basicAuth.password', 'pw']]);
  });

  it('registers nothing without headers or credentials', () => {
    const { seen, register } = collecting();
    registerGateSecrets(register, undefined, undefined);
    expect(seen).toEqual([]);
  });

  it('refuses a runner without the member when there is a value to register, and is quiet when there is none', () => {
    expect(() => registerGateSecrets(undefined, { 'x-vercel-protection-bypass': TOKEN }, undefined)).toThrow(
      /predates EngineAttemptContext\.registerSecret/,
    );
    expect(() => registerGateSecrets(undefined, { 'ngrok-skip-browser-warning': 'true' }, undefined)).not.toThrow();
  });
});

describe('registerStateSecrets', () => {
  const cookie = (name: string, value: string) => ({
    name, value, domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const,
  });

  it('registers cookie and local-storage values long enough to be tokens, and skips the short ones', () => {
    const { seen, register } = collecting();
    registerStateSecrets(register, {
      cookies: [cookie('sid', TOKEN), cookie('theme', 'dark')],
      origins: [{ origin: 'https://app.test', localStorage: [{ name: 'token', value: `${TOKEN}b` }, { name: 'marker', value: 'saved' }] }],
    });
    expect(seen).toEqual([
      ['cookie.sid', TOKEN],
      ['storage.token', `${TOKEN}b`],
    ]);
  });

  it('refuses a runner without the member when a value is long enough to register, and is quiet otherwise', () => {
    expect(() => registerStateSecrets(undefined, { cookies: [cookie('sid', TOKEN)], origins: [] })).toThrow(
      /predates EngineAttemptContext\.registerSecret/,
    );
    expect(() => registerStateSecrets(undefined, { cookies: [cookie('theme', 'dark')], origins: [] })).not.toThrow();
  });

  it('registers a value one short of the floor nowhere', () => {
    const { seen, register } = collecting();
    registerStateSecrets(register, { cookies: [cookie('sid', TOKEN.slice(1))], origins: [] });
    expect(seen).toEqual([]);
  });
});
