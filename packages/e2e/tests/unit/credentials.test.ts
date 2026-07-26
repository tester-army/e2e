import { afterEach, describe, expect, it } from 'vitest';
import { credentials, setCredentialRegistry } from '../../src/credentials.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import type { ResolvedCredential } from '../../src/config/resolve.ts';

const admin: ResolvedCredential = {
  name: 'admin',
  username: 'admin@example.com',
  password: 'super-secret-password',
  allowedOrigins: undefined,
};

afterEach(() => {
  setCredentialRegistry(undefined);
});

describe('credentials.user', () => {
  it('throws AUTH_CREDENTIAL_UNAVAILABLE when the runner is not active', () => {
    expect(() => credentials.user('admin')).toThrow(ConfigurationError);
    expect(() => credentials.user('admin')).toThrow(/runner is active/);
  });

  it('throws AUTH_CREDENTIAL_UNAVAILABLE for an unconfigured name', () => {
    setCredentialRegistry(new Map([['admin', admin]]));
    expect(() => credentials.user('missing')).toThrow(/"missing" is not configured/);
  });

  it('returns a frozen handle exposing username but never the password value', () => {
    setCredentialRegistry(new Map([['admin', admin]]));
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
    setCredentialRegistry(new Map([['admin', admin]]));
    const handle = credentials.user('admin');
    expect(handle.password.name).toBe('admin');
    expect(handle.password.purpose).toBe('password');
  });

  it('clearing the registry revokes availability again', () => {
    setCredentialRegistry(new Map([['admin', admin]]));
    expect(() => credentials.user('admin')).not.toThrow();
    setCredentialRegistry(undefined);
    expect(() => credentials.user('admin')).toThrow(/runner is active/);
  });

  it('replacing the registry swaps the visible credential set', () => {
    setCredentialRegistry(new Map([['admin', admin]]));
    setCredentialRegistry(
      new Map([['viewer', { ...admin, name: 'viewer', username: 'viewer@example.com' }]]),
    );
    expect(() => credentials.user('admin')).toThrow(/not configured/);
    expect(credentials.user('viewer').username).toBe('viewer@example.com');
  });
});
