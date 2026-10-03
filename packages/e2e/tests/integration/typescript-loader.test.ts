/**
 * e2e's TypeScript loader through the built CLI, the way a project meets it:
 * the TypeScript features, module formats, and import forms a config and its
 * tests use, in an ES module package and in a package without
 * `"type": "module"` (a Next.js app), with worker processes, plus the source
 * locations a failure reports and a config reloaded after an edit.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The built loader, as a project's CLI runs it.
const loaderModule = '../../dist/config/load.js';
const { loadConfigModule } = (await import(loaderModule)) as typeof import('../../src/config/load.ts');

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const FAILING = `import { expect, test } from 'e2e';

interface Shape { readonly n: number }

test('fails at a known line', () => {
  const shape: Shape = { n: 1 };
  expect(shape.n).toBe(2);
});
`;

const FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': `{
  // tsc reads JSONC, and so does the loader.
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@lib/*": ["lib/*"] },
    "experimentalDecorators": true,
    "jsx": "react",
    "jsxFactory": "h",
  },
}
`,
  'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { targetName } from './lib/config-helper';

export default { targets: [{ name: targetName, platform: 'test' }] } satisfies E2EConfig;
`,
  'lib/config-helper.ts': "export const targetName: string = 'local';\n",
  'lib/alias.ts': "export const alias = 'paths';\n",
  'lib/base.ts': "export const base = 'baseUrl';\n",
  'lib/plain.ts': "export const plain = 'extensionless';\n",
  'lib/suffixed.ts': "export const suffixed = 'js-suffix';\n",
  'lib/dir/index.ts': "export const index = 'dir-index';\n",
  'lib/esm.mts': "export const mts: string = 'mts';\n",
  'lib/cjs.cts': `import type { Stats } from 'node:fs';
import path = require('node:path');
import plain = require('./plain');
import alias = require('@lib/alias');
import helper = require('./cjs-helper.cjs');
const kind: string = path.extname('x.cts');
export = { cts: kind, stats: null as Stats | null, required: [plain.plain, alias.alias, helper.decorated(), helper.strict] };
`,
  'lib/cjs-helper.cts': `#!/usr/bin/env node
'use strict';
const seen: string[] = [];
function track(target: Function): void { seen.push(target.name); }
@track
class Decorated {}
export = { decorated: (): string[] => [...seen, Decorated.name], strict: (function (this: unknown) { return this === undefined; })() };
`,
  'lib/comp.jsx': "export const comp = () => 'jsx file';\n",
  // CommonJS throwing from a known line, with and without a directive prologue.
  'lib/thrower.cts': "/** A header comment. */\n'use strict';\nfunction boom(): never {\n  throw new Error('cts');\n}\nexport = { boom, strict: (function (this: unknown) { return this === undefined; })() };\n",
  'lib/thrower-sloppy.cts': "function boom(): never {\n  throw new Error('cts');\n}\nexport = { boom };\n",
  'lib/view.tsx': `export const h = (tag: string, _props: unknown, ...children: unknown[]): string => \`<\${tag}>\${children.join('')}</\${tag}>\`;
export const view = (): string => <b>jsx</b>;
`,
  'lib/features.ts': `export enum Color { Red, Green = 'green' }
export const enum Size { S = 1, M = 2 }
export namespace Shapes { export const sides = 4; }
const seen: string[] = [];
function track(target: Function): void { seen.push(target.name); }
@track
export class Box {
  constructor(public readonly width: number, private readonly secret = 's') {}
}
export const decorated = (): string[] => seen;
export const size = Size.M;
`,
  'lib/data.json': '{ "answer": 42 }\n',
  'internal/sub.ts': "export const sub = 'hash-import';\n",
  // With baseUrl ".", a root index a mangled # import would land on.
  'index.ts': "export const root = 'wrong file';\n",
  'packages/core/package.json': JSON.stringify({ name: '@scope/core', exports: { '.': './src/index.ts' } }),
  'packages/core/src/index.ts': "import { pad } from './pad.js';\n\nexport const month = (n: number): string => pad(n);\n",
  'packages/core/src/pad.ts': "export const pad = (n: number): string => String(n).padStart(2, '0');\n",
  'tests/features.e2e.ts': `import { expect, test } from 'e2e';
import type { E2EConfig } from 'e2e';
import { alias } from '@lib/alias';
import { base } from 'lib/base';
import { plain } from '../lib/plain';
import { suffixed } from '../lib/suffixed.js';
import { index } from '../lib/dir';
import { mts } from '../lib/esm.mts';
import cjs from '../lib/cjs.cts';
import { view } from '../lib/view.tsx';
import { comp } from '../lib/comp';
import thrower from '../lib/thrower.cts';
import sloppyThrower from '../lib/thrower-sloppy.cts';
import { Box, Color, Shapes, decorated, size } from '../lib/features';
import { sub } from '#internal/sub';
import { sub as viaJs } from '#js/sub';
import data from '../lib/data.json';
import attributed from '../lib/data.json' with { type: 'json' };
import { month } from '@scope/core';

const awaited = await Promise.resolve('top-level await');
const typed: E2EConfig | undefined = undefined;

test('imports resolve', () => {
  expect([alias, base, plain, suffixed, index, sub, viaJs, month(7)]).toEqual(['paths', 'baseUrl', 'extensionless', 'js-suffix', 'dir-index', 'hash-import', 'hash-import', '07']);
});

test('module formats load', () => {
  expect([mts, cjs.cts, data.answer, attributed.answer]).toEqual(['mts', '.cts', 42, 42]);
  expect(cjs.required).toEqual(['extensionless', 'paths', ['Decorated', 'Decorated'], true]);
  expect(comp()).toBe('jsx file');
  const stackOf = (boom: () => never): string => {
    try {
      return boom();
    } catch (error) {
      return (error as Error).stack ?? '';
    }
  };
  expect(stackOf(thrower.boom)).toContain('lib/thrower.cts:4:9');
  expect(thrower.strict).toBe(true);
  expect(stackOf(sloppyThrower.boom)).toContain('lib/thrower-sloppy.cts:2:9');
});

test('TypeScript compiles', () => {
  expect([Color.Green, Shapes.sides, new Box(3).width, decorated(), size, view(), awaited, typed]).toEqual(['green', 4, 3, ['Box'], 2, '<b>jsx</b>', 'top-level await', undefined]);
});
`,
  'tests/failing/fails.e2e.ts': FAILING,
  // A test the file declares through a helper it awaits: the file's own frame is an async one.
  'lib/declare.ts': "import { test } from 'e2e';\n\nexport async function declareLater(): Promise<void> {\n  await Promise.resolve();\n  test('declared after an await', () => {});\n}\n",
  'tests/failing/declared.e2e.ts': "import { declareLater } from '../../lib/declare';\n\nawait declareLater();\n",
  // URL syntax and a space in a file name, which a stack frame names as a path.
  'tests/failing/50% off #1.e2e.ts': FAILING,
};

let dir: string;

/** Writes `files` into the fixture project. */
function write(files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A project whose package.json is `manifest`, with e2e and a workspace package linked into node_modules. */
function createProject(manifest: Record<string, unknown>): void {
  write({ ...FILES, 'package.json': JSON.stringify({ name: 'loader-fixture', imports: { '#internal/*': './internal/*.ts', '#js/*': './internal/*.js' }, ...manifest }) });
  mkdirSync(path.join(dir, 'node_modules', '@scope'), { recursive: true });
  symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', 'e2e'), 'junction');
  symlinkSync(path.join(dir, 'packages', 'core'), path.join(dir, 'node_modules', '@scope', 'core'), 'junction');
}

/** Runs the CLI in the project; resolves with stdout, colors stripped (CI turns them on), whatever the exit code. */
async function runCli(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, 'run', '--no-cache', ...args], { cwd: dir });
    return { code: 0, stdout: stripVTControlCharacters(stdout) };
  } catch (error) {
    const failed = error as { code: number; stdout: string };
    return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout) };
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
    const { code, stdout } = await runCli('tests/features.e2e.ts', '--workers', '2');
    expect(stdout).toContain('3 passed');
    expect(code).toBe(0);
  });

  it('points a failure and its test at the TypeScript source', async () => {
    createProject({ type: 'module' });
    const { code, stdout } = await runCli('tests/failing');
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
