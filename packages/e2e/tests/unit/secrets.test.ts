import { afterEach, describe, expect, it } from 'vitest';
import { credentials, holdSecretRegistry, isSecret, secrets, setSecretRegistry, type SecretRegistry } from '../../src/secrets.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import type { ResolvedCredential, ResolvedSecret } from '../../src/config/resolve.ts';

const admin: ResolvedCredential = { name: 'admin', username: 'admin@example.com' };
const adminPassword: ResolvedSecret = {
  name: 'admin.password',
  purpose: 'password',
  value: 'super-secret-password',
};
const apiKey: ResolvedSecret = { name: 'api-key', purpose: 'generic-secret', value: 'sk_live_1' };
const adminToken: ResolvedSecret = { name: 'admin-token', purpose: 'generic-secret', value: 'tok_admin_1' };

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
    expect(handle.password.name).toBe('admin.password');
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
  it('throws SECRET_UNAVAILABLE for a name the running config does not declare', () => {
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

  it('never hands out a credential password: that is credentials.user(name).password', () => {
    setSecretRegistry(registry([admin], [adminPassword]));
    expect(() => secrets.get('admin')).toThrow(expect.objectContaining({
      code: 'SECRET_UNAVAILABLE',
      message: expect.stringContaining('"admin" is a credential, whose password is credentials.user("admin").password'),
    }));
    expect(() => secrets.get('admin.password')).toThrow(expect.objectContaining({
      code: 'SECRET_UNAVAILABLE',
      message: expect.stringContaining('use credentials.user("admin").password'),
    }));
  });

  it('keeps a secret and a credential of one name apart', () => {
    setSecretRegistry(registry([admin], [adminPassword, { name: 'admin', purpose: 'generic-secret', value: 'admin-api-key' }]));
    expect(secrets.get('admin')).toMatchObject({ name: 'admin', purpose: 'generic-secret' });
    expect(credentials.user('admin').password).toMatchObject({ name: 'admin.password', purpose: 'password' });
  });

  it('returns a reference by name before any run exists, for the config to hand an engine', () => {
    const deferred = secrets.get('admin');
    const unknown = secrets.get('not-declared-yet');
    expect(isSecret(deferred)).toBe(true);
    expect(Object.isFrozen(deferred)).toBe(true);
    expect(deferred.name).toBe('admin');
    expect(deferred.purpose).toBe('generic-secret');
    expect(unknown.name).toBe('not-declared-yet');
    // Only the resolved config knows the name is a credential's password.
    const password = secrets.get('admin.password');
    setSecretRegistry(registry([admin], [adminPassword]));
    expect(password.purpose).toBe('password');
  });

  it('refuses to become a string before any run exists, so a config cannot pass the reference off as the value', () => {
    const deferred = secrets.get('API_KEY');
    const refused = expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('secrets.get("API_KEY") is a reference to a secret, not its value'),
    });
    expect(() => `${deferred}`).toThrow(refused);
    expect(() => String(deferred)).toThrow(refused);
    expect(() => 'key=' + (deferred as unknown as string)).toThrow(refused);
    expect(() => deferred.toString()).toThrow(refused);
    expect(() => JSON.stringify({ key: deferred })).toThrow(refused);
    expect(Object.keys(deferred)).toEqual(['name', 'purpose']);
    expect(isSecret(deferred)).toBe(true);
  });
});

describe('holdSecretRegistry', () => {
  const withKey = registry([], [apiKey]);
  const withAdmin = registry([admin], [adminPassword, adminToken]);
  const throws = (name: string): boolean => {
    try {
      secrets.get(name);
      return false;
    } catch {
      return true;
    }
  };
  /** Whether an installed registry holds `name`: with none installed, `secrets.get()` defers instead of throwing, so an unknown name throws only under a registry. */
  const resolves = (name: string): boolean => throws('never-configured') && !throws(name);

  it('installs the newest registry still held when a hold is released', () => {
    const releaseKey = holdSecretRegistry(withKey);
    const releaseAdmin = holdSecretRegistry(withAdmin);
    expect(resolves('admin-token')).toBe(true);
    releaseAdmin();
    expect(resolves('api-key')).toBe(true);
    expect(resolves('admin-token')).toBe(false);
    releaseAdmin();
    expect(resolves('api-key')).toBe(true);
    releaseKey();
    expect(resolves('api-key')).toBe(false);
  });

  it('keeps a newer registry installed when an older hold is released', () => {
    const releaseKey = holdSecretRegistry(withKey);
    const releaseAdmin = holdSecretRegistry(withAdmin);
    releaseKey();
    expect(resolves('admin-token')).toBe(true);
    releaseAdmin();
    expect(resolves('admin-token')).toBe(false);
  });

  it('leaves a registry a run installed since in place', () => {
    const release = holdSecretRegistry(withKey);
    setSecretRegistry(withAdmin);
    release();
    expect(resolves('admin-token')).toBe(true);
  });
});
