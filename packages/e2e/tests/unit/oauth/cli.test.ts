import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cli from '../../../src/oauth/cli.ts';
import { OAuthError } from '../../../src/oauth/errors.ts';

function quietIo(out: string[]) {
  const write = (chunk: string) => (out.push(chunk), true);
  return { stdout: { write } as unknown as NodeJS.WritableStream, stderr: { write } as unknown as NodeJS.WritableStream, isTTY: false };
}

/** Never the developer's own credential file: every test names its logins through the environment store. */
beforeEach(() => {
  vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('e2e login / logout', () => {
  it('needs a named provider when there is no terminal to pick in', async () => {
    const out: string[] = [];
    expect(await cli.runLogin(undefined, {}, quietIo(out))).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, spacexai');
  });

  it('turns an unknown provider into one error line, not a stack trace', async () => {
    const out: string[] = [];
    expect(await cli.runLogout('nope', quietIo(out))).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, spacexai');
    expect(out.join('').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('e2e models', () => {
  it('lists models only for stored logins and says how to sign in when there is none', async () => {
    const out: string[] = [];
    expect(await cli.runModels(undefined, quietIo(out))).toBe(1);
    expect(out.join('')).toContain('no login is stored; sign in with e2e login <openai|github-copilot|spacexai>');
    out.length = 0;
    expect(await cli.runModels('spacexai', quietIo(out))).toBe(1);
    expect(out.join('')).toContain('no SpaceXAI login is stored; run `npx e2e login spacexai`');
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
