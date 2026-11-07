/**
 * The built CLI on Bun, the way a project without Node.js meets it: config
 * and tests in TypeScript across worker processes, failure locations, error
 * messages, a config reloaded after an edit, `e2e doctor`, the `node`
 * shebang `bun run` follows, and `e2e mcp` running tests. Every process runs
 * on the Bun binary `E2E_BUN` names (else `bun` on PATH) with a PATH that
 * holds no Node.js, so neither the CLI nor anything it spawns can reach one.
 * Without Bun the suite skips, unless `E2E_BUN` is set, as CI's Bun job does.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsupportedRuntimeMessage } from '../../src/internal/runtime.ts';
import { createTypeScriptProject, FILES, PACKAGE_ROOT, writeFiles } from '../helpers/typescript-project.ts';

const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** The Bun binary under test and its version; undefined when none runs and `E2E_BUN` does not ask for one. */
function findBun(): { readonly path: string; readonly version: string } | undefined {
  const required = process.env['E2E_BUN'];
  const found = spawnSync(required || 'bun', ['-e', 'process.stdout.write(`${process.execPath}\\n${Bun.version}`)'], { encoding: 'utf8' });
  if (found.status === 0) {
    const [execPath = '', version = ''] = found.stdout.split('\n');
    return { path: execPath, version };
  }
  if (required) throw new Error(`E2E_BUN=${required} does not run: ${found.error?.message ?? found.stderr}`);
  return undefined;
}

const bun = process.platform === 'win32' ? undefined : findBun();
const supported = bun !== undefined && unsupportedRuntimeMessage({ node: '0.0.0', bun: bun.version }, false) === undefined;

/** Replaces `from` with `to` in `text`, failing when the shared fixture no longer holds `from`. */
function edit(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`the TypeScript fixture no longer holds ${from}`);
  return text.replace(from, to);
}

/**
 * Proves the test process runs on Bun, and that the only `node` on its PATH
 * is Bun's own stand-in. It waits on a timer at its top level, which a
 * `require()` cannot finish, so the loader completes it with `import()`.
 */
const RUNTIME_TEST = `import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'e2e';

await new Promise((resolve) => setTimeout(resolve, 5));

test('runs on Bun with no Node.js on PATH', () => {
  expect(process.versions.bun).toBeDefined();
  const node = (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'node')).find((file) => existsSync(file));
  expect(node === undefined ? process.execPath : realpathSync(node)).toBe(realpathSync(process.execPath));
});
`;

/**
 * The loader fixture as Bun runs it, less what Bun does not load: a `#`
 * import of a directory (`#legacy/enums`, which e2e's Node.js loader
 * resolves to its index) and a legacy decorator in a `.cts` file (Bun's
 * transpiler writes an ES import of its helper into the CommonJS output).
 * JavaScriptCore puts a thrown error's column at the callee rather than at
 * `new`, so a stack is checked to the line.
 */
const BUN_FILES: Readonly<Record<string, string>> = {
  ...FILES,
  'tests/features.e2e.ts': [
    ["import { Role as RoleImport } from '#legacy/enums';\n", ''],
    ["expect([Role.Owner, RoleImport.Owner]).toEqual(['OWNER', 'OWNER']);", "expect(Role.Owner).toBe('OWNER');"],
    ["'lib/thrower.cts:4:9'", "'lib/thrower.cts:4:'"],
    ["'lib/thrower-sloppy.cts:2:9'", "'lib/thrower-sloppy.cts:2:'"],
  ].reduce((text, [from, to]) => edit(text, from!, to!), FILES['tests/features.e2e.ts']!),
  'lib/cjs-helper.cts': edit(FILES['lib/cjs-helper.cts']!, '@track\nclass Decorated {}\n', 'class Decorated {}\ntrack(Decorated);\n'),
  'tests/runtime.e2e.ts': RUNTIME_TEST,
};

let dir: string;
let bin: string;
let env: NodeJS.ProcessEnv;

/** Runs `args` under Bun in the project; resolves with the output, colors stripped, whatever the exit code. */
function runBun(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(path.join(bin, 'bun'), [...args], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) });
    });
  });
}

describe.runIf(bun !== undefined && !supported)('the CLI on a Bun older than it supports', () => {
  it('refuses to start, naming the floor', () => {
    const result = spawnSync(bun!.path, [CLI, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`e2e requires Bun 1.4.3 or newer; this is Bun ${bun!.version}`);
  });
});

describe.runIf(supported)('the CLI on Bun', () => {
  beforeEach(() => {
    // Outside the repository, which would lend the fixture its ESM package and tsconfig.json.
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-bun-runtime-'));
    // Bun, and git for the run's commit, first on a PATH that keeps no directory holding a `node`.
    bin = path.join(dir, '.bin');
    mkdirSync(bin);
    symlinkSync(bun!.path, path.join(bin, 'bun'));
    const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry !== '');
    const git = entries.map((entry) => path.join(entry, 'git')).find((file) => existsSync(file));
    if (git !== undefined) symlinkSync(git, path.join(bin, 'git'));
    env = { ...process.env, PATH: [bin, ...entries.filter((entry) => !existsSync(path.join(entry, 'node')))].join(path.delimiter) };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers --version, and e2e doctor names Bun', async () => {
    createTypeScriptProject(dir, { type: 'module' }, BUN_FILES);
    const version = await runBun([CLI, '--version']);
    expect(version.stdout.trim()).toBe((JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version);
    const doctor = await runBun([CLI, 'doctor', '--json']);
    const report = JSON.parse(doctor.stdout) as { checks: { id: string; status: string; message?: string }[] };
    expect(report.checks.find((check) => check.id === 'node')).toEqual({ id: 'node', status: 'pass', message: `Bun ${bun!.version} (>=1.4.3)` });
  });

  it.each([
    ['an ES module package', { type: 'module' }],
    ['a package without "type": "module"', {}],
  ])('runs config and tests in %s across Bun worker processes', async (_case, manifest) => {
    createTypeScriptProject(dir, manifest, BUN_FILES);
    const { code, stdout } = await runBun([CLI, 'run', '--no-cache', 'tests/features.e2e.ts', 'tests/runtime.e2e.ts', '--workers', '2']);
    expect(stdout).toContain('4 passed');
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(dir, '.e2e', 'report.json'), 'utf8')) as { run: { environment: { runtime: string } } };
    expect(report.run.environment.runtime).toBe(`bun v${bun!.version}`);
  });

  it('runs the CLI through its node shebang, as bun run and bunx do', async () => {
    createTypeScriptProject(dir, { type: 'module' }, BUN_FILES);
    // An installed bin, executable as a package manager leaves it, behind the shebang the CLI ships with.
    const shebang = readFileSync(CLI, 'utf8').split('\n')[0]!;
    expect(shebang).toBe('#!/usr/bin/env node');
    writeFiles(dir, { 'node_modules/.bin/e2e': `${shebang}\nimport ${JSON.stringify(pathToFileURL(CLI).href)};\n` });
    chmodSync(path.join(dir, 'node_modules', '.bin', 'e2e'), 0o755);
    const { code, stdout } = await runBun(['run', 'e2e', 'run', '--no-cache', 'tests/runtime.e2e.ts']);
    expect(stdout).toContain('1 passed');
    expect(code).toBe(0);
  });

  it('points a failure and its test at the TypeScript source', async () => {
    createTypeScriptProject(dir, { type: 'module' }, BUN_FILES);
    const files = ['tests/failing/fails.e2e.ts', 'tests/failing/50% off #1.e2e.ts'];
    const { code, stdout } = await runBun([CLI, 'run', '--no-cache', ...files]);
    expect(code).toBe(1);
    expect(stdout).toContain('   7|   expect(shape.n).toBe(2);');
    const report = JSON.stringify(JSON.parse(readFileSync(path.join(dir, '.e2e', 'report.json'), 'utf8')));
    for (const file of files) {
      expect(stdout).toContain(`❯ ${file}:7:19`);
      expect(report).toContain(`"source":{"file":"${file}","line":5,"column":1}`);
      expect(report).toContain(`"source":{"file":"${file}","line":7,"column":19}`);
    }
  });

  it('names the file, line, and column of a syntax error in the config', async () => {
    createTypeScriptProject(dir, { type: 'module' }, { ...BUN_FILES, 'e2e.config.ts': 'const broken: = 1;\nexport default {};\n' });
    const { code, stdout } = await runBun([CLI, 'run', '--no-cache']);
    expect(code).toBe(2);
    expect(stdout.replaceAll('\n', ' ')).toContain(`CONFIG_LOAD_FAILED`);
    expect(stdout.replaceAll('\n', ' ')).toContain(`${path.join(realpathSync(dir), 'e2e.config.ts')}:1:15: Unexpected`);
  });

  it('reloads an edited config graph on a graph load, and only the config file otherwise', async () => {
    createTypeScriptProject(dir, { type: 'module' }, {
      ...BUN_FILES,
      'e2e.config.ts': "import { targetName } from '@lib/config-helper';\nexport default { targets: [{ name: targetName, platform: 'test' }] };\n",
    });
    const helper = (name: string): string => `writeFileSync(${JSON.stringify(path.join(dir, 'lib', 'config-helper.ts'))}, "export const targetName: string = '${name}';\\n");`;
    writeFiles(dir, {
      'reload.mjs': `import { writeFileSync } from 'node:fs';
const { loadConfigModule } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'config', 'load.js')).href)});
const name = async (graph) => (await loadConfigModule(${JSON.stringify(path.join(dir, 'e2e.config.ts'))}, { graph })).targets[0].name;
const seen = [await name(false), await name(true)];
${helper('edited')}
seen.push(await name(false), await name(true), await name('watch-1'));
${helper('again')}
seen.push(await name('watch-1'), await name('watch-2'));
process.stdout.write(JSON.stringify(seen));
`,
    });
    const { code, stdout, stderr } = await runBun(['reload.mjs']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    // A graph shares its copy of the helper across loads under one name; a new name evaluates it afresh.
    expect(JSON.parse(stdout)).toEqual(['local', 'local', 'local', 'edited', 'edited', 'edited', 'again']);
  });

  it('evaluates a config in its load, where a secret it asks for stays a reference whatever registry is installed', async () => {
    createTypeScriptProject(dir, { type: 'module' }, {
      ...BUN_FILES,
      'e2e.config.ts': "import { secrets } from 'e2e';\nexport default { targets: [{ name: 'local', platform: 'test' }], key: secrets.get('API_KEY') };\n",
    });
    writeFiles(dir, {
      'references.mjs': `const { loadConfigModule } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'config', 'load.js')).href)});
// The registry a live session installs, which knows nothing of this config's secrets.
globalThis[Symbol.for('e2e.secrets.v1')] = { credentials: new Map(), secrets: new Map(), allSecrets: new Map() };
const config = await loadConfigModule(${JSON.stringify(path.join(dir, 'e2e.config.ts'))});
process.stdout.write(config.key.name);
`,
    });
    const { code, stdout, stderr } = await runBun(['references.mjs']);
    expect(stderr).toBe('');
    expect(stdout).toBe('API_KEY');
    expect(code).toBe(0);
  });

  it('serves e2e mcp, whose run_tests runs the CLI on Bun', async () => {
    createTypeScriptProject(dir, { type: 'module' }, BUN_FILES);
    const transport = new StdioClientTransport({ command: path.join(bin, 'bun'), args: [CLI, 'mcp'], cwd: dir, env: env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'e2e-bun-runtime', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('run_tests');
      const result = (await client.callTool({ name: 'run_tests', arguments: { files: ['tests/runtime.e2e.ts'] } }, { timeout: 60_000 })) as { content: { text?: string }[]; isError?: boolean };
      const text = result.content.map((part) => part.text ?? '').join('\n');
      expect(text).toContain('1 passed');
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  }, 90_000);
});
