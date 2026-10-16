import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cli from '../../../src/oauth/cli.ts';
import { OAuthError } from '../../../src/oauth/errors.ts';
import { login } from '../../../src/oauth/login.ts';

vi.mock('../../../src/oauth/login.ts', async (original) => ({ ...(await original<typeof import('../../../src/oauth/login.ts')>()), login: vi.fn() }));

function quietIo(out: string[]) {
  const write = (chunk: string) => (out.push(chunk), true);
  return { stdout: { write } as unknown as NodeJS.WritableStream, stderr: { write } as unknown as NodeJS.WritableStream, isTTY: false };
}

/** Never the developer's own credential file: every test names its logins through the environment store. */
beforeEach(() => {
  vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
  vi.stubEnv('OPENCODE_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('e2e login / logout', () => {
  it('needs a named provider when there is no terminal to pick in', async () => {
    const out: string[] = [];
    expect(await cli.runLogin(undefined, {}, quietIo(out))).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, opencode-console, spacexai');
  });

  it('turns an unknown provider into one error line, not a stack trace', async () => {
    const out: string[] = [];
    expect(await cli.runLogout('nope', quietIo(out))).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, opencode-console, spacexai');
    expect(out.join('').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('prints the sign-in URL on one unbordered line in a terminal, so it copies whole', async () => {
    const url = `https://auth.example.test/oauth/authorize?${'scope=openid+profile+email&'.repeat(8)}state=xyz`;
    vi.mocked(login).mockImplementationOnce(async (_id, { callbacks }) => {
      callbacks.onAuth({ url, userCode: 'ABCD-1234', instructions: 'Sign in in the browser.' });
      throw new OAuthError('CANCELLED', 'the login was cancelled');
    });
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => (printed.push(String(chunk)), true));
    const out: string[] = [];
    try {
      await cli.runLogin('openai', {}, { ...quietIo(out), isTTY: true, openUrl: () => undefined });
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
    }
    expect(printed.join('').split('\n')).toContain(url);
    expect(printed.join('')).toContain('ABCD-1234');
  });
});

describe('e2e models', () => {
  it('lists models only for stored logins and says how to sign in when there is none', async () => {
    const out: string[] = [];
    expect(await cli.runModels(undefined, quietIo(out))).toBe(1);
    expect(out.join('')).toContain('no login is stored; sign in with e2e login <openai|github-copilot|opencode-console|spacexai>, or set OPENCODE_API_KEY');
    out.length = 0;
    expect(await cli.runModels('spacexai', quietIo(out))).toBe(1);
    expect(out.join('')).toContain('no SpaceXAI login is stored; run `npx e2e login spacexai`');
  });

  it('lists a provider whose API key is set alongside the stored logins', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', JSON.stringify({ spacexai: { access: 'x', refresh: '', expires: 0 } }));
    vi.stubEnv('OPENCODE_API_KEY', 'oc_sk_env');
    const listed: string[] = [];
    const out: string[] = [];
    expect(await cli.runModels(undefined, quietIo(out), async (id) => (listed.push(id), []))).toBe(0);
    expect(listed).toEqual(['opencode-console', 'spacexai']);
  });

  it('prints one aligned line per model with vendor text stripped of terminal controls, and keeps going past a failing provider', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', JSON.stringify({ 'github-copilot': { access: 'gho', refresh: '', expires: 0 }, spacexai: { access: 'x', refresh: '', expires: 0 } }));
    const list = async (id: string) => {
      if (id === 'github-copilot') throw new OAuthError('FLOW_FAILED', 'GitHub Copilot did not list its models: 503: down');
      return [
        { id: 'grok-4', detail: 'vision; also grok-4-latest' },
        { id: 'grok-4-fast\u001b[31m', name: 'grok-4-fast\u001b[31m' },
        { id: 'grok-3' },
      ];
    };
    const out: string[] = [];
    expect(await cli.runModels(undefined, quietIo(out), list)).toBe(1);
    const text = out.join('');
    expect(text).toContain('GitHub Copilot (github-copilot): GitHub Copilot did not list its models: 503: down\n');
    expect(text).toContain(['SpaceXAI (spacexai): 3 models', '  grok-4       vision; also grok-4-latest', '  grok-4-fast', '  grok-3', ''].join('\n'));
    expect(text).not.toContain('\u001b');
    out.length = 0;
    expect(await cli.runModels('spacexai', quietIo(out), async () => [])).toBe(0);
    expect(out.join('')).toBe('SpaceXAI (spacexai): no models listed\n');
  });
});
