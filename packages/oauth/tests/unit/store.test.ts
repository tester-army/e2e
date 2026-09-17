import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIALS_ENV, FileCredentialStore, defaultCredentialsPath } from '../../src/index.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const creds = { access: 'a', refresh: 'r', expires: 123, accountId: 'acct' };

describe('FileCredentialStore', () => {
  it('creates the file with owner-only permissions and round-trips entries', async () => {
    const file = path.join(tempDir(), 'nested', 'oauth.json');
    const store = new FileCredentialStore({ path: file, env: {} });
    expect(await store.get('xai')).toBeUndefined();
    await store.set('xai', creds);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store.get('xai')).toEqual(creds);
    expect(await store.list()).toEqual(['xai']);
    await store.remove('xai');
    expect(await store.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
  });

  it('keeps other providers when one is written', async () => {
    const store = new FileCredentialStore({ path: path.join(tempDir(), 'oauth.json'), env: {} });
    await store.set('a', creds);
    await store.set('b', { ...creds, access: 'b' });
    expect((await store.get('a'))?.access).toBe('a');
    expect((await store.get('b'))?.access).toBe('b');
  });

  it('reads the environment override and never writes through it', async () => {
    const file = path.join(tempDir(), 'oauth.json');
    const env = { [CREDENTIALS_ENV]: JSON.stringify({ 'github-copilot': creds }) };
    const store = new FileCredentialStore({ path: file, env });
    expect(store.readOnly).toBe(true);
    expect(await store.get('github-copilot')).toEqual(creds);
    await store.set('xai', creds);
    expect(await store.get('xai')).toBeUndefined();
    expect(() => statSync(file)).toThrow();
  });

  it('rejects a malformed file with the path in the message', async () => {
    const file = path.join(tempDir(), 'oauth.json');
    const store = new FileCredentialStore({ path: file, env: {} });
    await store.set('x', creds);
    const broken = new FileCredentialStore({ path: file, env: {} });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{"x": {"access": 1}}');
    await expect(broken.get('x')).rejects.toThrow(/the entry for x is not a credential record/);
  });

  it('defaults to the XDG config directory', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/e2e/oauth.json');
    expect(defaultCredentialsPath({})).toMatch(/\.config\/e2e\/oauth\.json$/);
  });
});
