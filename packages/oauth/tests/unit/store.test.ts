import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIALS_ENV, EnvCredentialStore, FileCredentialStore, defaultCredentialStore, defaultCredentialsPath } from '../../src/index.ts';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'oauth.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const creds = { access: 'a', refresh: 'r', expires: 123, accountId: 'acct' };

describe('FileCredentialStore', () => {
  it('creates the file with owner-only permissions and round-trips entries', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    expect(await store.get('xai')).toBeUndefined();
    await store.set('xai', creds);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store.get('xai')).toEqual(creds);
    expect(await store.list()).toEqual(['xai']);
    await store.remove('xai');
    expect(await store.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(() => statSync(`${file}.lock`)).toThrow();
  });

  it('keeps other providers when one is written, even from concurrent writers', async () => {
    const file = tempFile();
    const a = new FileCredentialStore(file);
    const b = new FileCredentialStore(file);
    await Promise.all([a.set('a', creds), b.set('b', { ...creds, access: 'b' }), a.set('c', { ...creds, access: 'c' })]);
    expect((await a.list()).toSorted()).toEqual(['a', 'b', 'c']);
    expect((await b.get('b'))?.access).toBe('b');
  });

  it('takes over a stale lock left by a dead process', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, '');
    const old = Date.now() / 1000 - 60;
    const { utimesSync } = await import('node:fs');
    utimesSync(`${file}.lock`, old, old);
    await store.set('y', creds);
    expect((await store.list()).toSorted()).toEqual(['x', 'y']);
  });

  it('drops a damaged entry instead of losing every login', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(file, JSON.stringify({ x: creds, broken: { access: 1 }, nan: { access: 'a', refresh: 'r', expires: null } }));
    expect(await store.list()).toEqual(['x']);
    expect(await store.get('broken')).toBeUndefined();
  });

  it('defaults to the XDG config directory', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/e2e/oauth.json');
    expect(defaultCredentialsPath({})).toMatch(/\.config\/e2e\/oauth\.json$/);
  });
});

describe('EnvCredentialStore', () => {
  it('is chosen when the variable is set, reads it, and refuses to change it', async () => {
    const store = defaultCredentialStore({ [CREDENTIALS_ENV]: JSON.stringify({ 'github-copilot': creds }) });
    expect(store).toBeInstanceOf(EnvCredentialStore);
    expect(await store.get('github-copilot')).toEqual(creds);
    expect(await store.list()).toEqual(['github-copilot']);
    await expect(store.set('xai', creds)).rejects.toMatchObject({ code: 'MISCONFIGURED', message: expect.stringContaining(CREDENTIALS_ENV) });
    await expect(store.remove('github-copilot')).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(defaultCredentialStore({ [CREDENTIALS_ENV]: '' })).toBeInstanceOf(FileCredentialStore);
  });

  it('rejects malformed JSON naming the variable', () => {
    expect(() => new EnvCredentialStore('nope')).toThrow(new RegExp(`${CREDENTIALS_ENV} is not valid JSON`));
  });
});
