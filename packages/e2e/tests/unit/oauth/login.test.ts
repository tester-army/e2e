import { describe, expect, it } from 'vitest';
import { EnvCredentialStore } from '../../../src/oauth/store.ts';
import { logout } from '../../../src/oauth/login.ts';
import { MemoryCredentialStore } from './helpers/store.ts';

describe('logout', () => {
  it('reports whether a login was stored and writes nothing when there was none', async () => {
    const store = new MemoryCredentialStore({ spacexai: { access: 'a', refresh: 'r', expires: 0 } });
    expect(await logout('openai', store)).toBe(false);
    expect(await logout('spacexai', store)).toBe(true);
    expect(await store.list()).toEqual([]);
    // A read-only source is not asked to remove what it does not hold.
    expect(await logout('openai', new EnvCredentialStore('{}'))).toBe(false);
  });
});
