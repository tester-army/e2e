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

/** Links workspace packages into the fixture's node_modules, standing in for an install: the runner as `e2e`, everything else under `@e2e-dev`. */
function linkPackages(...names: readonly string[]): void {
  for (const name of names) {
    const target = path.join(dir, 'node_modules', ...(name === 'e2e' ? [name] : ['@e2e-dev', name]));
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
  it('preserves configured MCP server settings when reinitializing a project', async () => {
    const original = JSON.stringify({
      mcpServers: { e2e: { command: 'npx', args: ['e2e', 'mcp'], env: { APP_ENV: 'staging' }, timeout: 30_000 }, other: { command: 'other' } },
      clientSetting: true,
    }, null, 4) + '\n';
    writeFileSync(path.join(dir, '.mcp.json'), original);
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe(original);
  });

  it.each([undefined, 'http://localhost:4173'])(
    'loads the generated config and collects its example with APP_URL=%s',
    async (appUrl) => {
      vi.stubEnv('APP_URL', appUrl);
      await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
      linkPackages('e2e', 'web');
      linkModules('ai');

      const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
      const config = resolveConfig(raw, { projectRoot: dir, env: {} });
      const collection = await collect(config);

      expect(config.targets).toMatchObject([{ name: 'web', platform: 'web', engine: { name: 'web' } }]);
      // --yes writes the default gateway as its provider's constructor; the runner implies none, and no key is needed to load it.
      expect(readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8')).toContain("model: gateway('openai/gpt-6-luna-fast'),");
      expect(config.agent.model).toMatchObject({ provider: 'gateway', id: 'openai/gpt-6-luna-fast' });
      expect(config.targets[0]!.app.base).toMatchObject({ origin: appUrl ?? 'http://localhost:3000' });
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

    expect(scaffold.dependencies).not.toHaveProperty('@e2e-dev/web');
    expect(scaffold.dependencies).toMatchObject({ ai: '^7.0.0', '@openrouter/ai-sdk-provider': '^3.0.0' });
    expect(config.agent.model).toMatchObject({ provider: expect.stringMatching(/^openrouter/), id: 'openai/gpt-6-luna-fast' });
    expect(config.targets[0]!.app.base).toBeUndefined();
    expect(collection.tests.map((test) => test.title)).toEqual(['app responds']);
  });

  it.each([
    { host: 'darwin', platform: 'ios' },
    { host: 'linux', platform: 'android' },
  ] as const)('loads the $platform device scaffold generated on $host without a simulator', async ({ host, platform }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    const scaffold = createScaffold('mobile', { gateway: 'vercel' });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: scaffold.dependencies }));
    writeFileSync(path.join(dir, 'e2e.config.ts'), scaffold.config);
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), scaffold.example);
    linkPackages('e2e', 'mobile');
    linkModules('ai');

    const raw = await loadConfigModule(path.join(dir, 'e2e.config.ts'));
    const config = resolveConfig(raw, { projectRoot: dir, env: {} });
    const collection = await collect(config);

    expect(config.targets[0]!.app).toMatchObject({
      base: undefined,
      identity: platform === 'ios' ? 'Settings' : 'com.android.settings',
    });
    expect(config.workers).toBe(1);
    expect(config.targets).toMatchObject([{ name: platform, platform, engine: { name: 'mobile' } }]);
    expect(collection.tests.map((test) => test.title)).toEqual(['Settings opens']);
    // The engine installs agent-device itself; init writes the engine, never the driver.
    expect(scaffold.dependencies).toHaveProperty('@e2e-dev/mobile');
    expect(scaffold.dependencies).not.toHaveProperty('agent-device');
  });

  it('runs the generated browser example against any page without a model key', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e', 'web');
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
      const webVersion = (JSON.parse(readFileSync(path.resolve(PACKAGE_ROOT, '..', 'web', 'package.json'), 'utf8')) as { version: string }).version;
      expect(manifest.devDependencies['@e2e-dev/web']).toBe(dependencyRange(webVersion));
      const recorded = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'init', 'sibling-versions.json'), 'utf8')) as Record<string, string>;
      expect(Object.keys(recorded).toSorted()).toEqual(['@e2e-dev/mobile', '@e2e-dev/web']);
      expect(manifest.devDependencies).not.toHaveProperty('playwright');
      expect(manifest.devDependencies.ai).toBe('^7.0.0');
      expect(manifest.scripts).toEqual({ 'test:e2e': 'e2e run' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([undefined, '{}', '{"type":"commonjs"}'])(
    'loads a .ts config and collects .ts tests with their helpers when package.json is %s, and runs them under commonjs',
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
      if (manifest !== '{"type":"commonjs"}') return;

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

  it('runs tests that import and require a typeless workspace package exporting TypeScript source', async () => {
    writeFileSync(path.join(dir, 'package.json'), '{}');
    writeFileSync(path.join(dir, 'e2e.config.ts'), CONFIG);
    const core = path.join(dir, 'packages', 'core');
    mkdirSync(path.join(core, 'src', 'shared'), { recursive: true });
    writeFileSync(
      path.join(core, 'package.json'),
      JSON.stringify({ name: '@scope/core', exports: { './shared/*': './src/shared/*.ts' }, imports: { '#shared/*': './src/shared/*.ts' } }),
    );
    writeFileSync(path.join(core, 'src', 'shared', 'pad.ts'), "export const pad = (n: number): string => String(n).padStart(2, '0');\n");
    writeFileSync(
      path.join(core, 'src', 'shared', 'months.ts'),
      "import { pad } from '#shared/pad';\n\nexport const month = (date: Date): string => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;\n",
    );
    mkdirSync(path.join(dir, 'node_modules', '@scope'), { recursive: true });
    symlinkSync(core, path.join(dir, 'node_modules', '@scope', 'core'), 'junction');
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests', 'required.cjs'), "module.exports = require('@scope/core/shared/months');\n");
    writeFileSync(
      path.join(dir, 'tests', 'example.e2e.ts'),
      "import { expect, test } from 'e2e';\nimport { month } from '@scope/core/shared/months';\nimport required from './required.cjs';\n\ntest('workspace TypeScript loads', () => {\n  const date = new Date(Date.UTC(2026, 8, 1));\n  expect(month(date)).toBe('2026-09');\n  expect(required.month(date)).toBe('2026-09');\n});\n",
    );
    linkPackages('e2e');

    const { stdout } = await execFileAsync(process.execPath, [CLI, 'run', '--workers', '1', '--no-cache'], { cwd: dir });
    expect(stdout).toContain('1 passed');
  });

  it('tells a project that skipped npm install to run it, naming its package manager', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await expect(execFileAsync(process.execPath, [CLI, 'run'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringMatching(
        /Cannot find package '@e2e-dev\/web' imported from [\s\S]*?@e2e-dev\/web is declared in \S+package\.json but is not installed: run pnpm install/,
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

  it('names look-alike test files when the globs match nothing', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    linkPackages('e2e', 'web');
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

});
