/**
 * `e2e login` flags, from argv to the provider flow. Each flag is meant for
 * one provider and reaches its flow under that provider's own option name.
 * The flow is a double registered in place of the built-in provider, so no
 * browser opens and no vendor is called; the `--from-gh` failure drives the
 * real GitHub Copilot flow against a PATH with no `gh` on it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../../src/oauth/providers.ts';
import type { OAuthProvider } from '../../src/oauth/types.ts';

/** Doubles standing in for built-in providers, by id; a provider without one is the real one. */
const doubles = vi.hoisted(() => new Map<string, OAuthProvider>());

vi.mock('../../src/oauth/providers.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/oauth/providers.ts')>();
  return { ...actual, getProvider: (id: ProviderId) => doubles.get(id) ?? actual.getProvider(id) };
});

const { main } = await import('../../src/cli/index.ts');

/** What each double's flow was asked for, in order. */
const received: { readonly id: string; readonly options: unknown }[] = [];

/** A provider whose login records its options and hands back a non-expiring token. */
function flowDouble(id: ProviderId): OAuthProvider {
  return {
    id,
    name: `${id} double`,
    async login(_callbacks, options) {
      received.push({ id, options });
      return { access: 'token', refresh: '', expires: 0 };
    },
    async refresh() {
      throw new Error('a login is never refreshed here');
    },
  };
}

let configHome: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** Everything written to a stream so far, with any color stripped. */
function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

/** The logins the file store holds after a command, or undefined when it wrote none. */
function stored(): unknown {
  const file = path.join(configHome, 'e2e', 'oauth.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

async function login(...args: string[]): Promise<void> {
  await main(['node', 'e2e', 'login', ...args]);
}

beforeEach(() => {
  configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-login-'));
  // The file store under a throwaway config home: never the developer's own login file, nor the read-only environment store.
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
  vi.stubEnv('E2E_OAUTH_CREDENTIALS', '');
  doubles.set('openai', flowDouble('openai'));
  doubles.set('github-copilot', flowDouble('github-copilot'));
  received.length = 0;
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  doubles.clear();
  vi.unstubAllEnvs();
  rmSync(configHome, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('e2e login flags', () => {
  it('--device asks the ChatGPT flow for its device code method and stores what it returned', async () => {
    await login('openai', '--device');
    expect(received).toEqual([{ id: 'openai', options: { method: 'device' } }]);
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toContain('openai double login stored.\n');
    expect(stored()).toEqual({ openai: { access: 'token', refresh: '', expires: 0 } });
  });

  it('--client-id names the OAuth App the GitHub Copilot device flow runs with', async () => {
    await login('github-copilot', '--client-id', 'Iv23_my_app');
    expect(received).toEqual([{ id: 'github-copilot', options: { clientId: 'Iv23_my_app' } }]);
    expect(process.exitCode).toBe(0);
  });

  it('--from-gh asks the GitHub Copilot flow to reuse the GitHub CLI token', async () => {
    await login('github-copilot', '--from-gh');
    expect(received).toEqual([{ id: 'github-copilot', options: { fromGitHubCli: true } }]);
    expect(process.exitCode).toBe(0);
  });

  it('--enterprise-url names the GitHub Enterprise host', async () => {
    await login('github-copilot', '--enterprise-url', 'github.acme.com');
    expect(received).toEqual([{ id: 'github-copilot', options: { enterpriseUrl: 'github.acme.com' } }]);
    expect(process.exitCode).toBe(0);
  });

  it('drops a flag meant for another provider', async () => {
    await login('openai', '--client-id', 'Iv23_my_app', '--from-gh');
    expect(received).toEqual([{ id: 'openai', options: {} }]);
    expect(process.exitCode).toBe(0);
  });

  it('--from-gh with no signed-in GitHub CLI is one error line and exit 1', async () => {
    doubles.delete('github-copilot');
    const emptyBin = path.join(configHome, 'bin');
    mkdirSync(emptyBin);
    vi.stubEnv('PATH', emptyBin);
    await login('github-copilot', '--from-gh');
    expect(process.exitCode).toBe(1);
    expect(written(stderrSpy)).toBe(
      'GitHub Copilot login needs either the GitHub CLI signed in (gh auth login) or the client id of a GitHub OAuth App with the device flow enabled\n',
    );
    expect(stored()).toBeUndefined();
  });
});
