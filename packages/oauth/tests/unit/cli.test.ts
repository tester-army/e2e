import { describe, expect, it } from 'vitest';
import * as cli from '../../src/cli.ts';

/** The e2e CLI types this module by hand; the names it calls must exist here. */
describe('@e2edev/oauth/cli', () => {
  it('exports the entry points the e2e CLI calls', () => {
    expect(typeof cli.runLogin).toBe('function');
    expect(typeof cli.runLogout).toBe('function');
    expect(typeof cli.runStatus).toBe('function');
  });

  it('needs a named provider when there is no terminal to pick in', async () => {
    const out: string[] = [];
    const io = { stdout: { write: (chunk: string) => (out.push(chunk), true) } as unknown as NodeJS.WritableStream, stderr: { write: (chunk: string) => (out.push(chunk), true) } as unknown as NodeJS.WritableStream, isTTY: false };
    expect(await cli.runLogin(undefined, {}, io)).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, spacexai');
  });

  it('turns an unknown provider or flag into one error line, not a stack trace', async () => {
    const out: string[] = [];
    const io = { stdout: { write: (chunk: string) => (out.push(chunk), true) } as unknown as NodeJS.WritableStream, stderr: { write: (chunk: string) => (out.push(chunk), true) } as unknown as NodeJS.WritableStream, isTTY: false };
    expect(await cli.runLogout('nope', io)).toBe(1);
    expect(out.join('')).toContain('name a provider: openai, github-copilot, spacexai');
    expect(out.join('').split('\n').filter(Boolean)).toHaveLength(1);
    out.length = 0;
    expect(await cli.runOAuthCli(['login', 'spacexai', '--bogus'], io)).toBe(1);
    expect(out.join('')).toMatch(/bogus/);
    out.length = 0;
    expect(await cli.runOAuthCli(['logout', 'spacexai', 'extra'], io)).toBe(1);
    expect(out.join('')).toContain('unexpected argument extra');
  });
});
