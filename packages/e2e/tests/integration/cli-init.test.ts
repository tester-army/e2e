import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use the built modules, just as config and test imports use the installed packages.
const loaderModule = '../../dist/config/load.js';
const { loadConfigModule } = await import(loaderModule) as typeof import('../../src/config/load.ts');
const resolveModule = '../../dist/config/resolve.js';
const { resolveConfig } = await import(resolveModule) as typeof import('../../src/config/resolve.ts');
const collectModule = '../../dist/collect/collect.js';
const { collect } = await import(collectModule) as typeof import('../../src/collect/collect.ts');
const scaffoldModule = '../../dist/cli/init/scaffold.js';
const { createScaffold } = await import(scaffoldModule) as typeof import('../../src/cli/init/scaffold.ts');

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');
const CONFIG = "export default { targets: [{ name: 'local', platform: 'test' }] };\n";
let dir: string;

/** Links workspace packages into the fixture's node_modules, standing in for an install. */
function linkPackages(...names: readonly string[]): void {
  const scope = path.join(dir, 'node_modules', '@e2edev');
  mkdirSync(scope, { recursive: true });
  for (const name of names) {
    symlinkSync(path.resolve(PACKAGE_ROOT, '..', name), path.join(scope, name), 'junction');
  }
}

beforeEach(() => {
  // Fixtures under the repository inherit its ESM package and hide this failure.
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-integration-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('initializing standalone projects', () => {
  it.each([undefined, 'http://localhost:4173'])(
    'loads the generated config and collects its example with APP_URL=%s',
    async (appUrl) => {
      vi.stubEnv('APP_URL', appUrl);
      await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
      linkPackages('e2e');

      const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
      const config = resolveConfig(raw, { projectRoot: dir, env: {} });
      const collection = await collect(config);

      expect(config.app.base.origin).toBe(appUrl ?? 'http://localhost:3000');
      expect(collection.tests.map((test) => ({ title: test.title, file: test.file }))).toEqual([
        { title: 'app responds', file: 'tests/example.e2e.ts' },
      ]);
    },
  );

  it.each([
    { host: 'darwin', platform: 'ios' },
    { host: 'linux', platform: 'android' },
  ] as const)('loads the $platform device scaffold generated on $host without a simulator', async ({ host, platform }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    const scaffold = createScaffold('agent-device', true);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: scaffold.dependencies }));
    writeFileSync(path.join(dir, 'e2e.config.ts'), scaffold.config);
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), scaffold.example);
    linkPackages('e2e', 'agent-device');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    const collection = await collect(config);

    expect(config.app.configured).toBe(false);
    expect(config.workers).toBe(1);
    expect(config.targets).toMatchObject([{ name: platform, platform, backend: { name: 'agent-device' } }]);
    expect(collection.tests.map((test) => test.title)).toEqual(['Settings opens']);
  });

  it('runs the generated HTTP example without a backend or model calls', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e');
    const server = createServer((_request, response) => response.end('hello'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
      const { stdout } = await execFileAsync(process.execPath, [CLI, 'run', '--workers', '1', '--no-cache'], {
        cwd: dir,
        env: { ...process.env, APP_URL: `http://127.0.0.1:${address.port}` },
      });
      expect(stdout).toContain('1 passed');
      expect(existsSync(path.join(dir, 'node_modules', '@e2edev', 'playwright'))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).devDependencies.ai).toBe('^7.0.0');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([undefined, '{}', '{"type":"commonjs"}'])(
    'explains the ESM requirement when package.json is %s',
    async (manifest) => {
      if (manifest !== undefined) writeFileSync(path.join(dir, 'package.json'), manifest);
      writeFileSync(path.join(dir, 'e2e.config.ts'), CONFIG);

      await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
        code: 'CONFIG_LOAD_FAILED',
        message: expect.stringContaining('e2e requires ES modules'),
      });
      await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining(manifest === undefined ? 'run e2e init' : 'npm pkg set type=module'),
      });
    },
  );

  it('allows an .mts config but diagnoses a CommonJS scope around .ts tests', async () => {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(path.join(dir, 'e2e.config.mts'), CONFIG);
    const testsDir = path.join(dir, 'tests');
    mkdirSync(testsDir);
    writeFileSync(path.join(testsDir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(path.join(testsDir, 'example.e2e.ts'), 'export {};\n');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.mts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    await expect(collect(config)).rejects.toMatchObject({
      code: 'COLLECTION_ERROR',
      message: expect.stringContaining(`${path.join(testsDir, 'package.json')} does not set "type": "module"`),
    });
  });

  it('preserves the original load error for ESM projects', async () => {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(dir, 'e2e.config.ts'), "throw new Error('config setup failed');\n");
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: `failed to load config ${path.join(dir, 'e2e.config.ts')}: config setup failed`,
    });
  });

  it('uses the target package scope of a symlinked config', async () => {
    const sourceDir = path.join(dir, 'source');
    mkdirSync(sourceDir);
    writeFileSync(path.join(sourceDir, 'package.json'), '{"type":"module"}');
    const source = path.join(sourceDir, 'e2e.config.ts');
    writeFileSync(source, CONFIG);
    const linked = path.join(dir, 'e2e.config.ts');
    symlinkSync(source, linked, 'file');

    await expect(loadConfigModule(linked)).resolves.toMatchObject({
      targets: [{ name: 'local', platform: 'test' }],
    });
  });
});
