import { afterEach, describe, expect, it } from 'vitest';
import { credentials, secrets, setSecretRegistry, type SecretRegistry } from '../../src/secrets.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import type { ResolvedCredential, ResolvedSecret } from '../../src/config/resolve.ts';

const admin: ResolvedCredential = { name: 'admin', username: 'admin@example.com' };
const adminPassword: ResolvedSecret = {
  name: 'admin',
  purpose: 'password',
  value: 'super-secret-password',
};
const apiKey: ResolvedSecret = { name: 'api-key', purpose: 'generic-secret', value: 'sk_live_1' };

function registry(credentialList: ResolvedCredential[], secretList: ResolvedSecret[]): SecretRegistry {
  return {
    credentials: new Map(credentialList.map((entry) => [entry.name, entry])),
    secrets: new Map(secretList.map((entry) => [entry.name, entry])),
  };
}

afterEach(() => {
  setSecretRegistry(undefined);
});

describe('credentials.user', () => {
  it('throws AUTH_CREDENTIAL_UNAVAILABLE when the runner is not active', () => {
    expect(() => credentials.user('admin')).toThrow(ConfigurationError);
    expect(() => credentials.user('admin')).toThrow(/runner is active/);
  });

  it('throws AUTH_CREDENTIAL_UNAVAILABLE for an unconfigured name', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    expect(() => credentials.user('missing')).toThrow(/"missing" is not configured/);
  });

  it('returns a frozen handle exposing username but never the password value', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    const handle = credentials.user('admin');
    expect(handle.name).toBe('admin');
    expect(handle.username).toBe('admin@example.com');
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.password)).toBe(true);
    expect(JSON.stringify(handle)).not.toContain('super-secret-password');
    expect(Object.values(handle)).not.toContain('super-secret-password');
    expect(Object.values(handle.password)).not.toContain('super-secret-password');
  });

  it('models the password as an opaque secret handle', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    const handle = credentials.user('admin');
    expect(handle.password.name).toBe('admin');
    expect(handle.password.purpose).toBe('password');
  });

  it('clearing the registry revokes availability again', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    expect(() => credentials.user('admin')).not.toThrow();
    setSecretRegistry(undefined);
    expect(() => credentials.user('admin')).toThrow(/runner is active/);
  });

  it('replacing the registry swaps the visible credential set', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    setSecretRegistry(registry([{ name: 'viewer', username: 'viewer@example.com' }], []));
    expect(() => credentials.user('admin')).toThrow(/not configured/);
    expect(credentials.user('viewer').username).toBe('viewer@example.com');
  });
});

describe('secrets.get', () => {
  it('throws SECRET_UNAVAILABLE outside a runner and for an unconfigured name', () => {
    expect(() => secrets.get('api-key')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    setSecretRegistry(registry([], [apiKey]));
    expect(() => secrets.get('missing')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    expect(() => secrets.get('missing')).toThrow(/E2E_SECRET_MISSING/);
  });

  it('returns a frozen generic handle that never carries the value', () => {
    setSecretRegistry(registry([], [apiKey]));
    const handle = secrets.get('api-key');
    expect(handle).toMatchObject({ name: 'api-key', purpose: 'generic-secret' });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).not.toContain('sk_live_1');
  });

  it('hands out a credential password by its name with the password purpose', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    expect(secrets.get('admin').purpose).toBe('password');
  });
});
