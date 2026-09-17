import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login, logout } from '../../src/cli/login.ts';

let dir: string;
let stderr: string[];
const nodePath = process.env['NODE_PATH'];

/** vitest puts the workspace's virtual store on NODE_PATH, which would let a bare temp project resolve @e2edev/oauth. */
function setNodePath(value: string | undefined): void {
  if (value === undefined) delete process.env['NODE_PATH'];
  else process.env['NODE_PATH'] = value;
  (Module as unknown as Record<'_initPaths', () => void>)['_initPaths']();
}

beforeEach(() => {
  setNodePath('');
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-login-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"proj","type":"module"}');
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  setNodePath(nodePath);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `@e2edev/oauth` in the project's node_modules that records every call. */
function installFakeOAuth(): string {
  const root = path.join(dir, 'node_modules', '@e2edev', 'oauth');
  mkdirSync(root, { recursive: true });
  const log = path.join(dir, 'calls.json');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@e2edev/oauth', type: 'module', exports: { './cli': './cli.js' } }));
  writeFileSync(
    path.join(root, 'cli.js'),
    `import { writeFileSync } from 'node:fs';
const record = (call) => { writeFileSync(${JSON.stringify(log)}, JSON.stringify(call)); return 0; };
export const runLogin = async (provider, options) => record({ runLogin: [provider, options] });
export const runLogout = async (provider) => record({ runLogout: [provider] });
`,
  );
  return log;
}

describe('e2e login / logout', () => {
  it('exits 1 with the install line when the project lacks @e2edev/oauth', async () => {
    expect(await login(dir, 'spacexai', {})).toBe(1);
    expect(stderr.join('')).toContain('npm i -D @e2edev/oauth');
    expect(await logout(dir, 'spacexai')).toBe(1);
  });

  it('forwards the sign-in with typed options, leaves the pick to the package without a provider, and forgets one', async () => {
    const log = installFakeOAuth();
    const calls = () => JSON.parse(readFileSync(log, 'utf8'));
    expect(await login(dir, 'github-copilot', { device: true, clientId: 'Iv23', fromGh: true, enterpriseUrl: 'gh.acme.com' })).toBe(0);
    expect(calls()).toEqual({ runLogin: ['github-copilot', { method: 'device', clientId: 'Iv23', fromGitHubCli: true, enterpriseUrl: 'gh.acme.com' }] });
    expect(await login(dir, 'spacexai', {})).toBe(0);
    expect(calls()).toEqual({ runLogin: ['spacexai', {}] });
    expect(await login(dir, undefined, {})).toBe(0);
    expect(calls()).toEqual({ runLogin: [null, {}] });
    expect(await logout(dir, 'openai')).toBe(0);
    expect(calls()).toEqual({ runLogout: ['openai'] });
    expect(await logout(dir, undefined)).toBe(0);
    expect(calls()).toEqual({ runLogout: [null] });
  });
});
