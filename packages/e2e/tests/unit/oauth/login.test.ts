import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvCredentialStore } from '../../../src/oauth/store.ts';
import { login, logout } from '../../../src/oauth/login.ts';
import { getProvider } from '../../../src/oauth/providers.ts';
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

describe('login', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const credentials = { access: 'local-test', refresh: 'local-refresh', expires: 0 };
  const callbacks = { onAuth: vi.fn(), onPrompt: async () => '' };

  it('refuses an explicit environment store before starting provider authentication', async () => {
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    await expect(login('github-copilot', { callbacks, store: new EnvCredentialStore('{}') })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses the default environment store before starting provider authentication', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    await expect(login('github-copilot', { callbacks })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('still authenticates and saves to a supplied writable store with an environment override', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    const store = new MemoryCredentialStore();
    await expect(login('github-copilot', { callbacks, store })).resolves.toEqual(credentials);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(await store.get('github-copilot')).toEqual(credentials);
  });
});
