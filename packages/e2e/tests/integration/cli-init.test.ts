import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dependencyRange } from '../../src/cli/init/versions.ts';

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

/** Links workspace packages into the fixture's node_modules, standing in for an install: the runner as `e2e`, everything else under `@e2edev`. */
function linkPackages(...names: readonly string[]): void {
  for (const name of names) {
    const target = path.join(dir, 'node_modules', ...(name === 'e2e' ? [name] : ['@e2edev', name]));
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.resolve(PACKAGE_ROOT, '..', name), target, 'junction');
  }
}

/** Links provider packages the generated config imports (`ai`, a gateway's provider) from this package's own install. */
function linkModules(...names: readonly string[]): void {
  for (const name of names) {
    const target = path.join(dir, 'node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(PACKAGE_ROOT, 'node_modules', name), target, 'junction');
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
      linkPackages('e2e', 'playwright');
      linkModules('ai');

      const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
      const config = resolveConfig(raw, { projectRoot: dir, env: {} });
      const collection = await collect(config);

      expect(config.targets).toMatchObject([{ name: 'web', platform: 'web', engine: { name: 'playwright' } }]);
      // --yes writes the default gateway as its provider's constructor; the runner implies none, and no key is needed to load it.
      expect(readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8')).toContain("model: gateway('openai/gpt-5.6-luna'),");
      expect(config.agent.model).toMatchObject({ provider: 'gateway', id: 'openai/gpt-5.6-luna' });
      expect(config.targets[0]!.app.base).toMatchObject({ origin: appUrl ?? 'http://localhost:3000' });
      expect(config.targets[0]!.app.command).toBeUndefined();
      expect(collection.tests.map((test) => ({ title: test.title, file: test.file }))).toEqual([
        { title: 'app opens', file: 'tests/example.e2e.ts' },
      ]);
    },
  );

  it('loads the engine-less scaffold and collects its HTTP example', async () => {
    const scaffold = createScaffold('none', { gateway: 'openrouter' });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: scaffold.dependencies }));
    writeFileSync(path.join(dir, 'e2e.config.ts'), scaffold.config);
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), scaffold.example);
    linkPackages('e2e');
    linkModules('ai', '@openrouter/ai-sdk-provider');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    const collection = await collect(config);

    expect(scaffold.dependencies).not.toHaveProperty('@e2edev/playwright');
    expect(scaffold.dependencies).toMatchObject({ ai: '^7.0.0', '@openrouter/ai-sdk-provider': '^3.0.0' });
    expect(config.agent.model).toMatchObject({ provider: expect.stringMatching(/^openrouter/), id: 'openai/gpt-5.6-luna' });
    expect(config.targets[0]!.app.base).toBeUndefined();
    expect(collection.tests.map((test) => test.title)).toEqual(['app responds']);
  });

  it.each([
    { host: 'darwin', platform: 'ios' },
    { host: 'linux', platform: 'android' },
  ] as const)('loads the $platform device scaffold generated on $host without a simulator', async ({ host, platform }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    const scaffold = createScaffold('agent-device', { gateway: 'vercel' });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: scaffold.dependencies }));
    writeFileSync(path.join(dir, 'e2e.config.ts'), scaffold.config);
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), scaffold.example);
    linkPackages('e2e', 'agent-device');
    linkModules('ai');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    const collection = await collect(config);

    expect(config.targets[0]!.app).toMatchObject({
      base: undefined,
      identity: platform === 'ios' ? 'Settings' : 'com.android.settings',
    });
    expect(config.workers).toBe(1);
    expect(config.targets).toMatchObject([{ name: platform, platform, engine: { name: 'agent-device' } }]);
    expect(collection.tests.map((test) => test.title)).toEqual(['Settings opens']);
    // The engine installs agent-device itself; init writes the engine, never the driver.
    expect(scaffold.dependencies).toHaveProperty('@e2edev/agent-device');
    expect(scaffold.dependencies).not.toHaveProperty('agent-device');
  });

  it('runs the generated browser example against any page without a model key', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e', 'playwright');
    linkModules('ai');
    const server = createServer((_request, response) => response.end('<p>hello</p>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
      // The gateway model in the config constructs without a key; only an agent step would need one.
      const env: NodeJS.ProcessEnv = { ...process.env, APP_URL: `http://127.0.0.1:${address.port}` };
      delete env.AI_GATEWAY_API_KEY;
      const { stdout } = await execFileAsync(process.execPath, [CLI, 'run', '--workers', '1', '--no-cache'], { cwd: dir, env });
      expect(stdout).toContain('1 passed');
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const playwrightVersion = (JSON.parse(readFileSync(path.resolve(PACKAGE_ROOT, '..', 'playwright', 'package.json'), 'utf8')) as { version: string }).version;
      expect(manifest.devDependencies['@e2edev/playwright']).toBe(dependencyRange(playwrightVersion));
      const recorded = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'init', 'sibling-versions.json'), 'utf8')) as Record<string, string>;
      expect(Object.keys(recorded).toSorted()).toEqual(['@e2edev/agent-device', '@e2edev/playwright', 'playwright']);
      expect(manifest.devDependencies.playwright).toBe(`^${recorded.playwright}`);
      expect(manifest.devDependencies.ai).toBe('^7.0.0');
      expect(manifest.scripts).toEqual({ 'test:e2e': 'e2e run' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([undefined, '{}', '{"type":"commonjs"}'])(
    'loads a .ts config and runs .ts tests with their helpers when package.json is %s',
    async (manifest) => {
      if (manifest !== undefined) writeFileSync(path.join(dir, 'package.json'), manifest);
      writeFileSync(path.join(dir, 'e2e.config.ts'), CONFIG);
      mkdirSync(path.join(dir, 'tests'));
      writeFileSync(path.join(dir, 'tests/helper.ts'), 'export const answer = (): number => 42;\n');
      writeFileSync(
        path.join(dir, 'tests/example.e2e.ts'),
        "import { expect, test } from 'e2e';\nimport { answer } from './helper.ts';\n\ntest('helpers load as ES modules', () => {\n  expect(answer()).toBe(42);\n});\n",
      );
      linkPackages('e2e');

      const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
      const config = resolveConfig(raw, { projectRoot: dir, env: {} });
      const collection = await collect(config);
      expect(collection.tests.map((test) => test.title)).toEqual(['helpers load as ES modules']);

      const { stdout } = await execFileAsync(process.execPath, [CLI, 'run', '--workers', '1', '--no-cache'], { cwd: dir });
      expect(stdout).toContain('1 passed');
    },
  );

  it('collects .ts tests from a CommonJS-scoped tests directory next to an .mts config', async () => {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(path.join(dir, 'e2e.config.mts'), CONFIG);
    const testsDir = path.join(dir, 'tests');
    mkdirSync(testsDir);
    writeFileSync(path.join(testsDir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(path.join(testsDir, 'example.e2e.ts'), "import { test } from 'e2e';\n\ntest('registers', () => {});\n");
    linkPackages('e2e');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.mts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    const collection = await collect(config);
    expect(collection.tests.map((test) => test.title)).toEqual(['registers']);
  });

  it('tells a project that skipped npm install to run it, naming its package manager', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringMatching(
        /Cannot find package 'e2e' imported from [\s\S]*?e2e is declared in \S+package\.json but is not installed: run pnpm install/,
      ),
    });
  });

  it('names the missing config, the init command, and any look-alike file', async () => {
    await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringMatching(
        /CONFIG_NOT_FOUND[\s\S]*no e2e\.config\.ts or e2e\.config\.mts found in .* or its parent directories; run e2e init to create one, or pass --config <path>/,
      ),
    });
    writeFileSync(path.join(dir, 'e2e.config.js'), CONFIG);
    await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining(
        'found e2e.config.js, but only e2e.config.ts and e2e.config.mts are loaded: rename it and keep it an ES module',
      ),
    });
  });

  it('explains a removed export and a wrong subpath in the config', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e');
    writeFileSync(
      path.join(dir, 'e2e.config.ts'),
      "import { defineConfig } from 'e2e';\nexport default defineConfig({ targets: [{ name: 'local', platform: 'test' }] });\n",
    );
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: expect.stringContaining('defineConfig was removed in e2e 0.5'),
    });
    // The import must be used, or the TypeScript transform elides it.
    writeFileSync(path.join(dir, 'e2e.config.ts'), "import { test } from 'e2e/test';\nexport default { marker: test };\n");
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: expect.stringContaining('e2e exports e2e, e2e/agent, e2e/engine'),
    });
  });

  it('names look-alike test files when the globs match nothing', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e', 'playwright');
    linkModules('ai');
    writeFileSync(path.join(dir, 'tests', 'login.test.ts'), 'export {};\n');
    rmSync(path.join(dir, 'tests', 'example.e2e.ts'));
    await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringMatching(
        /no test file matched "tests\/\*\*\/\*\.e2e\.ts" under \S+; found tests\/login\.test\.ts, which the pattern does not match: rename to \*\.e2e\.ts/,
      ),
    });
  });

  it('preserves the original load error', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), "throw new Error('config setup failed');\n");
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: `failed to load config ${path.join(dir, 'e2e.config.ts')}: config setup failed`,
    });
  });

  it('loads a config through a symlink', async () => {
    const sourceDir = path.join(dir, 'source');
    mkdirSync(sourceDir);
    const source = path.join(sourceDir, 'e2e.config.ts');
    writeFileSync(source, CONFIG);
    const linked = path.join(dir, 'e2e.config.ts');
    symlinkSync(source, linked, 'file');

    await expect(loadConfigModule(linked)).resolves.toMatchObject({
      targets: [{ name: 'local', platform: 'test' }],
    });
  });
});
