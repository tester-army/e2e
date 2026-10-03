import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { LoadHookContext, ResolveHookContext } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { load, resolve } from '../../src/config/esm-hooks.ts';

type Resolution = { url: string; format?: string | null | undefined };

const IMPORT = ['node', 'import'];
const REQUIRE = ['node', 'require'];

// Created at collection: the case tables below name files in it.
const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-esm-hooks-'));
const project = path.join(dir, 'app');

/** Writes `files` under the project directory. */
function write(files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const url = (relative: string): string => pathToFileURL(path.join(project, relative)).href;

/**
 * Resolves `specifier` from `parentURL` through the hook. The stand-in for
 * Node.js's own resolution records what it was asked, resolves relative
 * specifiers and paths, and fails like Node.js for a file that is not on
 * disk; `exports` maps a bare or `#` specifier to the URL a package's map
 * names, existing or not.
 */
function resolveFrom(
  parentURL: string | undefined,
  specifier: string,
  { format = null, conditions = IMPORT, exports = {} }: { format?: string | null; conditions?: string[]; exports?: Record<string, string> } = {},
): { resolution: Resolution; asked: string[] } {
  const asked: string[] = [];
  const context: ResolveHookContext = { conditions, importAttributes: {}, parentURL };
  const resolution = resolve(specifier, context, (next, nextContext) => {
    asked.push(next);
    const target =
      exports[next] ?? (/^(?:node|data):/.test(next) ? next : path.isAbsolute(next) ? pathToFileURL(next).href : new URL(next, nextContext?.parentURL ?? 'file:///').href);
    if (target.startsWith('file:') && !target.startsWith('file:///app/')) {
      try {
        readFileSync(fileURLToPath(target));
      } catch {
        throw Object.assign(new Error(`Cannot find module '${target}'`), { code: 'ERR_MODULE_NOT_FOUND', url: target });
      }
    }
    return { url: target, format };
  });
  return { resolution, asked };
}

beforeAll(() => {
  write({
    'tsconfig.json': '{\n  // JSONC, as tsc reads it\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } },\n}\n',
    // A root index, which the empty request a `#` import is not must never reach.
    'index.ts': '',
    'e2e.config.ts': '',
    'tests/example.e2e.ts': '',
    'tests/plain.js': '',
    'internal/sub.ts': '',
    'lib/helper.ts': '',
    'lib/view.tsx': '',
    'lib/esm.mts': '',
    'lib/cjs.cts': '',
    'lib/only.js': '',
    'lib/util.js': '',
    'lib/data.json': '{}',
    'lib/comp.jsx': '',
    'lib/dir/index.ts': '',
    'node_modules/dep/index.ts': '',
    'node_modules/dep/helper.ts': '',
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolve', () => {
  it.each([
    ['./x.js to x.ts', '../lib/helper.js', 'lib/helper.ts'],
    ['./x.js to x.tsx', '../lib/view.js', 'lib/view.tsx'],
    ['./x.js to x.jsx', '../lib/comp.js', 'lib/comp.jsx'],
    ['./x.mjs to x.mts', '../lib/esm.mjs', 'lib/esm.mts'],
    ['./x.cjs to x.cts', '../lib/cjs.cjs', 'lib/cjs.cts'],
    ['an extensionless import', '../lib/helper', 'lib/helper.ts'],
    ['an extensionless JavaScript import', '../lib/util', 'lib/util.js'],
    ['an extensionless JSON import', '../lib/data', 'lib/data.json'],
    ['a directory to its index', '../lib/dir', 'lib/dir/index.ts'],
    ['a tsconfig paths alias', '@lib/helper', 'lib/helper.ts'],
    ['a tsconfig baseUrl import', 'lib/view', 'lib/view.tsx'],
  ])('resolves %s from TypeScript', (_case, specifier, file) => {
    expect(resolveFrom(url('tests/example.e2e.ts'), specifier).asked).toEqual([url(file)]);
  });

  it.each([
    ['an extensionless import', '../lib/util'],
    ['an extensionless TypeScript import', '../lib/helper'],
    ['an extensionless JSON import', '../lib/data'],
    ['a directory import', '../lib/dir'],
    ['./x.js naming x.ts', '../lib/helper.js'],
    ['a tsconfig alias', '@lib/helper'],
  ])('gives JavaScript Node.js resolution: %s fails as Node.js reports it', (_case, specifier) => {
    expect(() => resolveFrom(url('tests/plain.js'), specifier)).toThrow('Cannot find module');
  });

  it('keeps the query and hash of the specifier', () => {
    expect(resolveFrom(url('tests/example.e2e.ts'), '../lib/helper?v=1#x').asked).toEqual([`${url('lib/helper.ts')}?v=1#x`]);
  });

  it.each([
    ['an extensionless import', './helper', 'lib/helper.ts'],
    ['./x.js to x.ts', './helper.js', 'lib/helper.ts'],
    ['a tsconfig paths alias', '@lib/helper', 'lib/helper.ts'],
  ])('hands a require() of %s from TypeScript a path, which the CommonJS resolver takes', (_case, specifier, file) => {
    const { asked, resolution } = resolveFrom(url('lib/cjs.cts'), specifier, { conditions: REQUIRE });
    expect(asked).toEqual([path.join(project, file)]);
    expect(resolution).toEqual({ url: url(file), format: 'module' });
  });

  it('retries a # import from TypeScript that maps to a missing ./x.js on x.ts', () => {
    const exports = { '#js/sub': url('internal/sub.js') };
    expect(resolveFrom(url('tests/example.e2e.ts'), '#js/sub', { exports }).asked).toEqual(['#js/sub', url('internal/sub.ts')]);
  });

  it.each([
    ['from JavaScript', 'tests/plain.js', { '#js/sub': url('internal/sub.js') }, '#js/sub'],
    ['with no TypeScript behind it', 'tests/example.e2e.ts', { '#gone': url('internal/gone.js') }, '#gone'],
    ['to an extensionless target', 'tests/example.e2e.ts', { '#bare': url('internal/sub') }, '#bare'],
  ])('leaves a # import %s missing as Node.js reports it', (_case, parent, exports, specifier) => {
    expect(() => resolveFrom(url(parent), specifier, { exports })).toThrow('Cannot find module');
  });

  it.each([
    ['a file that exists as written', 'tests/example.e2e.ts', '../lib/only.js'],
    ['a # import', 'tests/example.e2e.ts', '#lib/helper'],
    ['a builtin a paths pattern could match', 'tests/example.e2e.ts', 'node:fs'],
    ['a path inside an installed package', 'node_modules/dep/index.ts', './helper.ts'],
  ])('leaves %s to Node.js', (_case, parent, specifier) => {
    expect(resolveFrom(url(parent), specifier, { exports: { '#lib/helper': 'file:///app/lib/helper.ts' } }).asked).toEqual([specifier]);
  });

  it('gives an installed package TypeScript resolution but not the project tsconfig', () => {
    expect(resolveFrom(url('node_modules/dep/index.ts'), './helper').asked).toEqual([url('node_modules/dep/helper.ts')]);
    expect(resolveFrom(url('node_modules/dep/index.ts'), '@lib/helper', { exports: { '@lib/helper': 'file:///app/elsewhere.js' } }).asked).toEqual([
      '@lib/helper',
    ]);
  });

  it.each([
    ['.ts', 'lib/helper.ts', 'commonjs-typescript', 'module'],
    ['.tsx', 'lib/view.tsx', null, 'module'],
    ['.mts', 'lib/esm.mts', 'module-typescript', 'module'],
    ['.cts', 'lib/cjs.cts', 'commonjs-typescript', 'commonjs'],
    ['.jsx', 'lib/comp.jsx', null, 'module'],
    ['installed .ts', 'node_modules/dep/index.ts', 'commonjs', 'module'],
  ])('runs %s as %s whatever the package scope says, for import and require', (_case, file, format, expected) => {
    expect(resolveFrom(undefined, url(file), { format }).resolution).toEqual({ url: url(file), format: expected });
    expect(resolveFrom(url('tests/plain.js'), path.join(project, file), { format, conditions: REQUIRE }).resolution.format).toBe(expected);
  });

  it.each([
    ['JavaScript', 'file:///app/a.js', 'commonjs'],
    ['a builtin', 'node:path', 'builtin'],
    ['a data: URL', 'data:text/javascript,export%20{}', null],
  ])('leaves the format of %s alone', (_case, specifier, format) => {
    expect(resolveFrom(undefined, specifier, { format }).resolution).toEqual({ url: specifier, format });
  });

  it.each(['tests/plain.js', 'tests/example.e2e.ts'])('leaves an @oxc-project/runtime import %s writes to the project', (parent) => {
    const exports = { '@oxc-project/runtime/helpers/decorate': 'file:///app/node_modules/@oxc-project/runtime/decorate.js' };
    expect(resolveFrom(url(parent), '@oxc-project/runtime/helpers/decorate', { exports }).asked).toEqual(['@oxc-project/runtime/helpers/decorate']);
  });
});

describe('fresh module graphs', () => {
  const fromGraph = (relative: string): string => `${url(relative)}?e2e=module-3&e2e-graph=module-3`;

  it.each([
    ['a relative import', './e2e.config.ts', 'e2e.config.ts'],
    ['an extensionless import', './lib/helper', 'lib/helper.ts'],
    ['a tsconfig alias the loader maps', '@lib/helper', 'lib/helper.ts'],
  ])('hands the graph on to %s', (_case, specifier, file) => {
    expect(resolveFrom(fromGraph('e2e.config.ts'), specifier, { format: 'module' }).resolution.url).toBe(`${url(file)}?e2e-graph=module-3`);
  });

  it('hands the graph on to a # import and keeps the query a resolution already carries', () => {
    const exports = { '#sub': `${url('internal/sub.ts')}?v=1` };
    expect(resolveFrom(fromGraph('e2e.config.ts'), '#sub', { exports }).resolution.url).toBe(`${url('internal/sub.ts')}?v=1&e2e-graph=module-3`);
  });

  it.each([
    ['a package by name', fromGraph('e2e.config.ts'), '@e2e-dev/web', { '@e2e-dev/web': 'file:///app/packages/web/dist/index.js' }],
    ['a file under node_modules', `${url('node_modules/dep/index.ts')}?e2e-graph=module-3`, './helper.ts', {}],
    ['an importer outside any graph', `${url('e2e.config.ts')}?e2e=module-1`, './lib/helper.ts', {}],
    ['a builtin', fromGraph('e2e.config.ts'), 'node:path', {}],
  ])('leaves %s alone', (_case, parentURL, specifier, exports) => {
    expect(resolveFrom(parentURL, specifier, { exports }).resolution.url).not.toContain('e2e-graph');
  });

  it('leaves a require() out of fresh graphs, which CommonJS cannot load twice', () => {
    expect(resolveFrom(fromGraph('lib/cjs.cts'), './helper', { conditions: REQUIRE }).resolution.url).toBe(url('lib/helper.ts'));
  });

  it('reads tsconfig.json afresh for a new graph and once for every other load', () => {
    write({ 'graph/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@x': ['./a.ts'] } } }), 'graph/a.ts': '', 'graph/b.ts': '', 'graph/main.ts': '' });
    const parent = (graph: string | undefined): string => `${url('graph/main.ts')}${graph === undefined ? '' : `?e2e-graph=${graph}`}`;
    expect(resolveFrom(parent(undefined), '@x').asked).toEqual([url('graph/a.ts')]);
    expect(resolveFrom(parent('g-1'), '@x').asked).toEqual([url('graph/a.ts')]);
    write({ 'graph/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@x': ['./b.ts'] } } }) });
    expect(resolveFrom(parent('g-2'), '@x').asked).toEqual([url('graph/b.ts')]);
    expect(resolveFrom(parent('g-1'), '@x').asked).toEqual([url('graph/a.ts')]);
    expect(resolveFrom(parent(undefined), '@x').asked).toEqual([url('graph/a.ts')]);
  });
});

describe('load', () => {
  const context = (overrides: Partial<LoadHookContext> = {}): LoadHookContext => ({
    conditions: IMPORT,
    format: undefined,
    importAttributes: {},
    ...overrides,
  });

  /** A stand-in for Node.js's own load: the file's bytes, with the format and attributes it was asked for. */
  function nextFromDisk(asked: LoadHookContext[]) {
    return (next: string, nextContext?: Partial<LoadHookContext>) => {
      asked.push(nextContext as LoadHookContext);
      return { format: nextContext?.format ?? 'next', source: readFileSync(fileURLToPath(next)) };
    };
  }

  it('compiles TypeScript Node.js loaded, as the format its extension calls for', () => {
    write({ 'lib/typed.ts': 'export const n: number = 1;\n', 'lib/typed.cts': 'const n: number = 1;\nmodule.exports = n;\n' });
    const asked: LoadHookContext[] = [];
    const esm = load(`${url('lib/typed.ts')}?e2e=collect-1`, context(), nextFromDisk(asked));
    expect(esm).toMatchObject({ format: 'module', shortCircuit: true });
    expect(String(esm.source)).toContain('export const n = 1;');
    const cjs = load(url('lib/typed.cts'), context({ conditions: REQUIRE }), nextFromDisk(asked));
    expect(cjs).toMatchObject({ format: 'commonjs' });
    expect(String(cjs.source)).toContain('module.exports = n;');
    expect(asked.map((nextContext) => nextContext.format)).toEqual(['module', 'commonjs']);
  });

  it('compiles with the project tsconfig, and an installed package without it', () => {
    write({ 'jsx/tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react', jsxFactory: 'h' } }), 'jsx/view.tsx': 'export const a = <b />;\n' });
    write({ 'jsx/node_modules/dep/view.tsx': 'export const a = <b />;\n' });
    expect(String(load(url('jsx/view.tsx'), context(), nextFromDisk([])).source)).toContain('h("b"');
    expect(String(load(url('jsx/node_modules/dep/view.tsx'), context(), nextFromDisk([])).source)).toContain('React.createElement("b"');
  });

  it('loads JSON imported without a type attribute as a module exporting the parsed file', async () => {
    write({ 'lib/settings.json': '﻿{ "__proto__": { "polluted": true }, "answer": 42 }' });
    const asked: LoadHookContext[] = [];
    const loaded = load(url('lib/settings.json'), context(), nextFromDisk(asked));
    expect(loaded.format).toBe('module');
    expect(asked[0]).toMatchObject({ format: 'json', importAttributes: { type: 'json' } });
    const module = (await import(`data:text/javascript,${encodeURIComponent(String(loaded.source))}`)) as { default: Record<string, unknown> };
    expect(module.default['answer']).toBe(42);
    expect(Object.getPrototypeOf(module.default)).toBe(Object.prototype);
  });

  it.each([
    ['JSON with a type attribute', 'lib/data.json', context({ importAttributes: { type: 'json' } })],
    ['JSON a require() reads', 'lib/data.json', context({ conditions: REQUIRE })],
    ['JavaScript', 'lib/only.js', context()],
  ])('hands %s to Node.js', (_case, file, loadContext) => {
    const passThrough = () => ({ format: 'next', source: 'next' });
    expect(load(url(file), loadContext, passThrough)).toEqual({ format: 'next', source: 'next' });
  });
});
