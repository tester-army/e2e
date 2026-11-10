/**
 * e2e's TypeScript loader through the built CLI, the way a project meets it:
 * the TypeScript features, module formats, and import forms a config and its
 * tests use, in an ES module package and in a package without
 * `"type": "module"` (a Next.js app), with worker processes, plus the source
 * locations a failure reports and a config reloaded after an edit.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTypeScriptProject, PACKAGE_ROOT, writeFiles } from '../helpers/typescript-project.ts';

// The built loader, as a project's CLI runs it.
const loaderModule = '../../dist/config/load.js';
const { loadConfigModule } = (await import(loaderModule)) as typeof import('../../src/config/load.ts');

const execFileAsync = promisify(execFile);
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

let dir: string;

/** Writes `files` into the fixture project. */
function write(files: Readonly<Record<string, string>>): void {
  writeFiles(dir, files);
}

/** A project whose package.json is `manifest`, with e2e and a workspace package linked into node_modules. */
function createProject(manifest: Record<string, unknown>): void {
  createTypeScriptProject(dir, manifest);
}

/**
 * Runs the CLI in the project, with `env` added to this process's; resolves
 * with its output, colors stripped (CI turns them on), whatever the exit code.
 */
async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'run', '--no-cache', ...args], { cwd: dir, env: { ...process.env, ...env } });
    return { code: 0, stdout: stripVTControlCharacters(stdout), stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: failed.stderr };
  }
}

beforeEach(() => {
  // Outside the repository, which would lend the fixture its ESM package and tsconfig.json.
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-typescript-loader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the TypeScript loader', () => {
  it.each([
    ['an ES module package', { type: 'module' }],
    ['a package without "type": "module"', {}],
  ])('runs config and tests in %s across worker processes', async (_case, manifest) => {
    createProject(manifest);
    const { code, stdout } = await runCli(['tests/features.e2e.ts', '--workers', '2']);
    expect(stdout).toContain('3 passed');
    expect(code).toBe(0);
  });

  it('points a failure and its test at the TypeScript source', async () => {
    createProject({ type: 'module' });
    const { code, stdout } = await runCli(['tests/failing']);
    expect(code).toBe(1);
    expect(stdout).toContain('   7|   expect(shape.n).toBe(2);');
    const report = JSON.stringify(JSON.parse(readFileSync(path.join(dir, '.e2e', 'report.json'), 'utf8')));
    for (const file of ['tests/failing/fails.e2e.ts', 'tests/failing/50% off #1.e2e.ts']) {
      expect(stdout).toContain(`❯ ${file}:7:19`);
      expect(report).toContain(`"source":{"file":"${file}","line":5,"column":1}`);
      expect(report).toContain(`"source":{"file":"${file}","line":7,"column":19}`);
    }
    expect(report).toMatch(/"source":\{"file":"tests\/failing\/declared\.e2e\.ts","line":3,"column":\d+\}/);
  });

  // Node.js 24.8.0 to 24.11.0 refuses a load result with no source before e2e's hook sees it.
  const rejectsMissingSource = /^24\.(?:[89]|10)\.|^24\.11\.0$/.test(process.versions.node);
  it.skipIf(rejectsMissingSource)('compiles a .cts a loader earlier in the chain hands on without source, as Yarn PnP does', async () => {
    createProject({ type: 'module' });
    const loader = `export async function load(url, context, nextLoad) {\n  if (url.split('?')[0].endsWith('.cts')) return { format: 'commonjs', source: undefined, shortCircuit: true };\n  return nextLoad(url, context);\n}\n`;
    write({ 'chained-loader.mjs': loader, 'register.mjs': "import { register } from 'node:module';\nregister('./chained-loader.mjs', import.meta.url);\n" });
    const { code, stdout } = await runCli(['tests/features.e2e.ts'], { NODE_OPTIONS: `--import ${pathToFileURL(path.join(dir, 'register.mjs')).href}` });
    expect(stdout).toContain('3 passed');
    expect(code).toBe(0);
  });

  it('warns about a tsconfig.json whose extends is not installed, and runs without it', async () => {
    createProject({ type: 'module' });
    write({
      'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node22/tsconfig.json' }),
      'tests/plain.e2e.ts': "import { expect, test } from 'e2e';\n\ntest('runs', () => {\n  expect(1 as number).toBe(1);\n});\n",
    });
    write({ 'tests/other.e2e.ts': "import { test } from 'e2e';\n\ntest('also runs', () => {});\n" });
    const { code, stdout, stderr } = await runCli(['tests/plain.e2e.ts', 'tests/other.e2e.ts', '--workers', '2']);
    expect(stdout).toContain('2 passed');
    expect(code).toBe(0);
    // Reached by the runner while it collects, so the reporter shows it under `stderr | runner`.
    const output = `${stdout}${stderr}`;
    expect(output.split('e2e ignores').length - 1).toBe(1);
    expect(output).toContain(`e2e ignores ${path.join(realpathSync(dir), 'tsconfig.json')}, which it cannot read`);
    expect(output).toContain('@tsconfig/node22/tsconfig.json');
  });

  it('warns about an unreadable tsconfig.json only a worker reaches', async () => {
    createProject({ type: 'module' });
    write({
      'nested/tsconfig.json': JSON.stringify({ extends: '@tsconfig/missing/tsconfig.json' }),
      'nested/mod.ts': 'export const value: number = 1;\n',
      'tests/late.e2e.ts': "import { expect, test } from 'e2e';\n\ntest('imports late', async () => {\n  const { value } = await import('../nested/mod.ts');\n  expect(value).toBe(1);\n});\n",
    });
    const { code, stdout, stderr } = await runCli(['tests/late.e2e.ts']);
    expect(stdout).toContain('1 passed');
    expect(code).toBe(0);
    // Reached inside a test, so the reporter shows it under that test's output.
    const output = `${stdout}${stderr}`;
    expect(output.split('e2e ignores').length - 1).toBe(1);
    expect(output).toContain(`e2e ignores ${path.join(realpathSync(dir), 'nested', 'tsconfig.json')}`);
  });

  it('runs --version without oxc, and fails a run with TYPESCRIPT_COMPILER_UNAVAILABLE naming the binding', async () => {
    createProject({ type: 'module' });
    const hook = "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, nextResolve) {\n  if (specifier === 'oxc-transform') throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');\n  return nextResolve(specifier, context);\n} });\n";
    write({ 'no-oxc.mjs': hook });
    const env = { NODE_OPTIONS: `--import ${pathToFileURL(path.join(dir, 'no-oxc.mjs')).href}` };
    const version = await execFileAsync(process.execPath, [CLI, '--version'], { cwd: dir, env: { ...process.env, ...env } });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const { code, stdout } = await runCli(['tests/features.e2e.ts'], env);
    expect(code).toBe(3);
    const output = stdout.replaceAll('\n', ' ');
    expect(output).toContain('TYPESCRIPT_COMPILER_UNAVAILABLE');
    expect(output).toContain(`@oxc-transform/binding-${process.platform}-${process.arch}`);
  });

  it('runs --version, --help, and a test that takes no screenshot without @napi-rs/image', async () => {
    createProject({ type: 'module' });
    const hook = "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, nextResolve) {\n  if (specifier === '@napi-rs/image') throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');\n  return nextResolve(specifier, context);\n} });\n";
    write({
      'no-image.mjs': hook,
      'tests/plain.e2e.ts': "import { expect, test } from 'e2e';\n\ntest('runs', () => {\n  expect(1 as number).toBe(1);\n});\n",
    });
    const env = { NODE_OPTIONS: `--import ${pathToFileURL(path.join(dir, 'no-image.mjs')).href}` };
    for (const flag of ['--version', '--help']) {
      const { stdout } = await execFileAsync(process.execPath, [CLI, flag], { cwd: dir, env: { ...process.env, ...env } });
      expect(stdout.length).toBeGreaterThan(0);
    }
    const { code, stdout } = await runCli(['tests/plain.e2e.ts'], env);
    expect(stdout).toContain('1 passed');
    expect(code).toBe(0);
  });

  it.each([
    ['an auto-accessor', { 'lib/accessor.ts': 'export class A {\n  accessor w = 5;\n}\n' }, '../lib/accessor', 'lib/accessor.ts:2:3: `accessor` class fields (auto-accessors) are not supported'],
    [
      'a type imported as a value for decorator metadata',
      {
        'tsconfig.json': JSON.stringify({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }),
        'lib/types.ts': 'export interface Options { a: number }\n',
        'lib/svc.ts': "import { Options } from './types';\n\nconst Prop = (): PropertyDecorator => () => {};\n\nexport class Svc {\n  @Prop() options!: Options;\n}\n",
      },
      '../lib/svc',
      "lib/svc.ts:1); if Options is a type (an interface or a type alias), import it with import type { Options }",
    ],
  ])('names the line and the fix for %s', async (_case, files, specifier, message) => {
    createProject({ type: 'module' });
    write({ ...files, 'tests/uses.e2e.ts': `import { test } from 'e2e';\nimport '${specifier}';\n\ntest('loads', () => {});\n` });
    const { code, stdout } = await runCli(['tests/uses.e2e.ts']);
    expect(code).toBe(2);
    expect(stdout.replaceAll('\n', ' ')).toContain(message);
  });

  it('names the file, line, and column of a syntax error in the config', async () => {
    createProject({ type: 'module' });
    write({ 'e2e.config.ts': "const broken: = 1;\nexport default {};\n" });
    // Node.js names the module by its real path, which the temporary directory's may not be.
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: `failed to load config ${path.join(dir, 'e2e.config.ts')}: ${path.join(realpathSync(dir), 'e2e.config.ts')}:1:15: Unexpected token`,
    });
  });

  it('reloads an edited config graph and tsconfig.json on a graph load, and only the config file otherwise', async () => {
    createProject({ type: 'module' });
    write({
      'e2e.config.ts': "import { targetName } from '@lib/config-helper';\nexport default { targets: [{ name: targetName, platform: 'test' }] };\n",
      'lib/other.ts': "export const targetName = 'other';\n",
    });
    const configPath = path.join(dir, 'e2e.config.ts');
    const names = async (graph: boolean) => (await loadConfigModule(configPath, { graph })).targets?.map((target) => target.name);
    expect(await names(false)).toEqual(['local']);
    expect(await names(true)).toEqual(['local']);

    write({ 'lib/config-helper.ts': "export const targetName: string = 'edited';\n" });
    expect(await names(false)).toEqual(['local']);
    expect(await names(true)).toEqual(['edited']);

    write({ 'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/config-helper': ['./lib/other.ts'] } } }) });
    expect(await names(true)).toEqual(['other']);
  });
});

describe('nested TypeScript solution loading', () => {
  it('loads a config alias through two solution reference levels', async () => {
    createProject({ type: 'module' });
    write({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'configs/solution.json' }] }),
      'configs/solution.json': JSON.stringify({ files: [], references: [{ path: 'app.json' }] }),
      'configs/app.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@nested/*': ['lib/*'] } }, include: ['../*.ts', '../lib/*.ts'] }),
      'e2e.config.ts': "import { targetName } from '@nested/config-helper'; export default { targets: [{ name: targetName, platform: 'test' }] };\n",
    });
    const loaded = await loadConfigModule(path.join(dir, 'e2e.config.ts'), { graph: true });
    expect(loaded.targets?.[0]?.name).toBe('local');
  });
});
