/**
 * The TypeScript project the loader suites run: the TypeScript features,
 * module formats, and import forms a config and its tests use, with e2e and
 * three workspace packages linked into `node_modules`.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The e2e package these suites test, linked into each project as `e2e`. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const FAILING = `import { expect, test } from 'e2e';

interface Shape { readonly n: number }

test('fails at a known line', () => {
  const shape: Shape = { n: 1 };
  expect(shape.n).toBe(2);
});
`;

export const FILES: Readonly<Record<string, string>> = {
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
export = { cts: kind, stats: null as Stats | null, required: [plain.plain, alias.alias, helper.decorated(), helper.strict], resolved: require.resolve('./plain') };
// A trailing comment, which oxc prints after its CommonJS module marker.
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
  // Export and import maps that name TypeScript sources without an extension.
  'packages/noext/package.json': JSON.stringify({ name: '@scope/noext', type: 'module', exports: { './*': './src/*' } }),
  'packages/noext/src/foo.ts': "export const foo = 'no-extension export';\n",
  // A package without `exports` whose subpath names a directory of TypeScript.
  'packages/legacy/package.json': JSON.stringify({ name: '@scope/legacy' }),
  'packages/legacy/enums/index.ts': "export const Role = { Owner: 'OWNER' } as const;\n",
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
import { foo } from '@scope/noext/foo';
import { foo as fooImport } from '#noext/foo';
import { Role } from '@scope/legacy/enums';
import { Role as RoleImport } from '#legacy/enums';

const awaited = await Promise.resolve('top-level await');
const typed: E2EConfig | undefined = undefined;

test('imports resolve', () => {
  expect([alias, base, plain, suffixed, index, sub, viaJs, month(7)]).toEqual(['paths', 'baseUrl', 'extensionless', 'js-suffix', 'dir-index', 'hash-import', 'hash-import', '07']);
  expect([foo, fooImport]).toEqual(['no-extension export', 'no-extension export']);
  expect([Role.Owner, RoleImport.Owner]).toEqual(['OWNER', 'OWNER']);
});

test('module formats load', () => {
  expect([mts, cjs.cts, data.answer, attributed.answer]).toEqual(['mts', '.cts', 42, 42]);
  expect(cjs.required).toEqual(['extensionless', 'paths', ['Decorated', 'Decorated'], true]);
  expect(cjs.resolved).toMatch(/lib[\\\\/]plain\\.ts$/);
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

/** Writes `files` into `dir`, creating the directories they sit in. */
export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Writes `files` as a project in `dir` whose package.json is `manifest` plus the fixture's `imports`, with e2e and the workspace packages linked into node_modules. */
export function createTypeScriptProject(dir: string, manifest: Record<string, unknown>, files: Readonly<Record<string, string>> = FILES): void {
  const imports = { '#internal/*': './internal/*.ts', '#js/*': './internal/*.js', '#noext/*': './packages/noext/src/*', '#legacy/*': './packages/legacy/*' };
  writeFiles(dir, { ...files, 'package.json': JSON.stringify({ name: 'loader-fixture', imports, ...manifest }) });
  mkdirSync(path.join(dir, 'node_modules', '@scope'), { recursive: true });
  symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', 'e2e'), 'junction');
  for (const name of ['core', 'noext', 'legacy']) symlinkSync(path.join(dir, 'packages', name), path.join(dir, 'node_modules', '@scope', name), 'junction');
}
