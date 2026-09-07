import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../src/cli/init.ts';

vi.mock('@clack/prompts', { spy: true });
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Captures user-facing output without ANSI formatting. */
function output(): string {
  return stdoutSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join('');
}

/** Reads one file from the throwaway project. */
function read(file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

/** A completed `spawnSync` result with the given exit status. */
function spawnResult(status: number): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status, signal: null };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0');
  vi.mocked(clack.select).mockReset().mockResolvedValue('none');
  vi.mocked(clack.confirm).mockReset().mockResolvedValue(false);
  vi.mocked(clack.isCancel).mockImplementation((value) => typeof value === 'symbol');
  vi.mocked(spawnSync).mockReset().mockReturnValue(spawnResult(0));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('e2e init', () => {
  it('adds the runner and AI with --yes and does not install or prompt', async () => {
    expect(await init(dir, { yes: true })).toBe(0);
    expect(JSON.parse(read('package.json'))).toEqual({
      private: true,
      type: 'module',
      devDependencies: { '@e2edev/e2e': expect.stringMatching(/^\^\d+\.\d+\.\d+/), ai: '^7.0.0' },
    });
    expect(read('e2e.config.ts')).toContain('createAgent');
    expect(read('e2e.config.ts')).not.toContain('playwright');
    expect(read('tests/example.e2e.ts')).toContain("test('app responds'");
    expect(read('.gitignore')).toContain('node_modules/');
    expect(read('.gitignore')).toContain('.e2e/junit.xml');
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('next: npm install, then APP_URL=http://localhost:3000 npx --no-install e2e run');
  });

  it.each([
    { backend: 'none', ai: false },
    { backend: 'none', ai: true },
    { backend: 'playwright', ai: false },
    { backend: 'playwright', ai: true },
    { backend: 'agent-device', ai: false },
    { backend: 'agent-device', ai: true },
  ] as const)('matches imports and dependencies to backend=$backend, ai=$ai', async ({ backend, ai }) => {
    vi.mocked(clack.select).mockResolvedValueOnce(backend);
    vi.mocked(clack.confirm).mockResolvedValueOnce(ai).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const manifest = JSON.parse(read('package.json'));
    const device = backend === 'agent-device';
    expect(Object.keys(manifest.devDependencies)).toEqual([
      '@e2edev/e2e',
      ...(backend === 'playwright' ? ['@e2edev/playwright'] : []),
      ...(device ? ['@e2edev/agent-device'] : []),
      ...(ai ? ['ai'] : []),
    ]);
    expect(manifest.devDependencies.ai).toBe(ai ? '^7.0.0' : undefined);
    expect(read('e2e.config.ts').includes('createAgent')).toBe(ai);
    expect(read('e2e.config.ts').includes('@e2edev/playwright')).toBe(backend === 'playwright');
    expect(read('tests/example.e2e.ts').includes('@e2edev/playwright')).toBe(backend === 'playwright');
    expect(read('e2e.config.ts').includes('@e2edev/agent-device')).toBe(device);
    expect(read('tests/example.e2e.ts').includes('@e2edev/agent-device')).toBe(device);
    expect(read('e2e.config.ts').includes('APP_URL')).toBe(backend === 'playwright');
    expect(output()).toContain(`next: npm install, then ${device ? '' : 'APP_URL=http://localhost:3000 '}npx --no-install e2e run`);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    { host: 'darwin', platform: 'ios', app: 'Settings', label: 'General' },
    { host: 'linux', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
    { host: 'win32', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
  ] as const)('defaults agent-device to $platform on $host', async ({ host, platform, app, label }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    vi.mocked(clack.select).mockResolvedValueOnce('agent-device');
    vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await init(dir)).toBe(0);
    expect(clack.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      options: [
        expect.objectContaining({ value: 'none' }),
        expect.objectContaining({ value: 'playwright' }),
        expect.objectContaining({ value: 'agent-device' }),
      ],
    }));
    expect(read('e2e.config.ts')).toContain(`agentDevice({ platform: '${platform}', app: '${app}' })`);
    expect(read('tests/example.e2e.ts')).toContain(label);
  });

  it('accepts interactive selections and installs once after writing all files', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
      expect(read('e2e.config.ts')).toContain('createAgent');
      expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(true);
      return spawnResult(0);
    });

    expect(await init(dir)).toBe(0);
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('AI SDK v7'), initialValue: true }));
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Install dependencies with npm?' }));
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('npm', ['install'], {
      cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
    });
    expect(output()).toContain('next: APP_URL=http://localhost:3000 npx --no-install e2e run');
  });

  it('writes the selected dependencies when installation is declined', async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('next: npm install, then APP_URL=');
  });

  it.each(['backend', 'ai', 'files', 'install'])('leaves the directory untouched when cancelling at %s', async (stage) => {
    const cancel = Symbol('cancel');
    vi.mocked(clack.select).mockResolvedValueOnce(stage === 'backend' ? cancel : 'playwright');
    vi.mocked(clack.confirm)
      .mockResolvedValueOnce(stage === 'ai' ? cancel : true)
      .mockResolvedValueOnce(stage !== 'files')
      .mockResolvedValueOnce(cancel);

    expect(await init(dir)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([undefined, 'commonjs', 'module'])(
    'preserves existing dependency versions and type %s',
    async (type) => {
      const manifest = `${JSON.stringify({ name: 'existing-app', type, dependencies: { '@e2edev/e2e': 'workspace:*', ai: '^7.0.12' } }, null, 4)}\n`;
      writeFileSync(path.join(dir, 'package.json'), manifest);
      for (let run = 0; run < 2; run += 1) {
        stdoutSpy.mockClear();
        await init(dir, { yes: true });
        expect(read('package.json')).toBe(manifest);
        expect(output().includes('npm pkg set type=module')).toBe(type !== 'module');
      }
    },
  );

  it('adds missing dependencies without changing existing fields, ranges, or formatting', async () => {
    const manifest = {
      name: 'existing-app', type: 'commonjs', scripts: { dev: 'vite' },
      dependencies: { ai: '^7.0.12' },
      devDependencies: { '@e2edev/playwright': 'file:../backend', vite: '^7.0.0' },
      custom: { enabled: true },
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 4).replaceAll('\n', '\r\n')}\r\n`);
    vi.mocked(clack.select).mockResolvedValueOnce('playwright');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    expect(JSON.parse(read('package.json'))).toEqual({
      ...manifest,
      devDependencies: { ...manifest.devDependencies, '@e2edev/e2e': expect.any(String) },
    });
    expect(read('package.json')).toContain('\r\n    "name"');
  });

  it.each(['{broken', 'null', '{"devDependencies":false}'])('rejects invalid package.json before writing (%s)', async (manifest) => {
    writeFileSync(path.join(dir, 'package.json'), manifest);
    expect(await init(dir, { yes: true })).toBe(2);
    expect(read('package.json')).toBe(manifest);
    expect(readdirSync(dir)).toEqual(['package.json']);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['packageManager', 'lockfile'])('uses pnpm when selected by the %s', async (source) => {
    if (source === 'packageManager') {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', packageManager: 'pnpm@10.2.1' }));
    } else {
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    }
    vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await init(dir);
    expect(spawnSync).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: dir }));
  });

  it('keeps the scaffold and returns a failure when installation fails', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(1));
    vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    expect(await init(dir)).toBe(2);
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
    expect(output()).toContain('retry with npm install');
  });

  it.each(['e2e.config.ts', 'e2e.config.mts'])('never overwrites an existing %s or assumes its optional packages', async (config) => {
    writeFileSync(path.join(dir, config), '// custom config\n');
    await init(dir, { yes: true });
    expect(read(config)).toBe('// custom config\n');
    expect(Object.keys(JSON.parse(read('package.json')).devDependencies)).toEqual(['@e2edev/e2e']);
    if (config.endsWith('.mts')) expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(false);
  });

  it('reconciles new .gitignore entries without replacing existing source files', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n');
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), '// custom test\n');
    const older = 'node_modules/\n.e2e/artifacts/\n.e2e/cache/\n.e2e/sessions/\n.e2e/report.json\n';
    writeFileSync(path.join(dir, '.gitignore'), older);
    await init(dir, { yes: true });
    expect(read('e2e.config.ts')).toBe('// custom config\n');
    expect(read('tests/example.e2e.ts')).toBe('// custom test\n');
    expect(read('.gitignore')).toBe(`${older}.e2e/ai-trace.json\n.e2e/junit.xml\n.e2e/logs/\n`);
  });

  it('is idempotent', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const files = ['package.json', 'e2e.config.ts', 'tests/example.e2e.ts', '.gitignore'];
    const before = files.map(read);
    await init(dir, { yes: true });
    expect(files.map(read)).toEqual(before);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('preserves existing ignores and appends only missing entries', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\r\n.e2e/artifacts/');
    await init(dir, { yes: true });
    expect(read('.gitignore').startsWith('node_modules/\r\n.e2e/artifacts/\n')).toBe(true);
    expect(read('.gitignore').match(/\.e2e\/artifacts\//g)).toHaveLength(1);
    expect(read('.gitignore')).toContain('.e2e/sessions/');
  });
});
