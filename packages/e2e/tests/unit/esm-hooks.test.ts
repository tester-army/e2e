import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { LoadHookContext, ResolveHookContext } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inGraph, load, resolve } from '../../src/config/esm-hooks.ts';
import { forgetTsconfigs } from '../../src/config/tsconfig.ts';

type Resolution = { url: string; format?: string | null | undefined };

const IMPORT = ['node', 'import'];
const REQUIRE = ['node', 'require'];

/**
 * Resolves `specifier` from `parentURL` through the hook, with a stand-in for
 * Node's own resolution as `nextResolve` that records what it was asked and
 * reports `missing` as Node.js does a file that is not there.
 */
function resolveFrom(
  parentURL: string | undefined,
  specifier: string,
  { format = null, conditions = IMPORT, missing }: { format?: string | null; conditions?: string[]; missing?: string } = {},
): { resolution: Resolution; asked: string[] } {
  const asked: string[] = [];
  const context: ResolveHookContext = { conditions, importAttributes: {}, parentURL };
  const resolution = resolve(specifier, context, (next, nextContext) => {
    asked.push(next);
    if (next === specifier && missing !== undefined) {
      throw Object.assign(new Error(`Cannot find module '${missing}'`), { code: 'ERR_MODULE_NOT_FOUND', url: missing });
    }
    const url = /^(?:file|node|data):/.test(next) ? next : path.isAbsolute(next) ? pathToFileURL(next).href : new URL(next, nextContext?.parentURL ?? 'file:///').href;
    return { url, format };
  });
  return { resolution, asked };
}

let dir: string;
let project: string;

/** Writes `files` under the project directory. */
function write(files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const url = (relative: string): string => pathToFileURL(path.join(project, relative)).href;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-esm-hooks-'));
  project = path.join(dir, 'app');
  write({
    'tsconfig.json': '{\n  // JSONC, as tsc reads it\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } },\n}\n',
    // A root index, which the empty request a `#` import is not must never reach.
    'index.ts': '',
    'tests/example.e2e.ts': '',
    'tests/plain.js': '',
    'internal/sub.ts': '',
    'lib/helper.ts': '',
    'lib/view.tsx': '',
    'lib/esm.mts': '',
    'lib/cjs.cts': '',
    'lib/only.js': '',
    'lib/data.json': '{}',
    'lib/dir/index.ts': '',
    'node_modules/dep/index.ts': '',
    'node_modules/dep/helper.ts': '',
  });
  forgetTsconfigs();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolve', () => {
  it.each([
    ['./x.js to x.ts', '../lib/helper.js', 'lib/helper.ts'],
    ['./x.js to x.tsx', '../lib/view.js', 'lib/view.tsx'],
    ['./x.jsx to x.tsx', '../lib/view.jsx', 'lib/view.tsx'],
    ['./x.mjs to x.mts', '../lib/esm.mjs', 'lib/esm.mts'],
    ['./x.cjs to x.cts', '../lib/cjs.cjs', 'lib/cjs.cts'],
    ['an extensionless import', '../lib/helper', 'lib/helper.ts'],
    ['an extensionless JSON import', '../lib/data', 'lib/data.json'],
    ['a directory to its index', '../lib/dir', 'lib/dir/index.ts'],
    ['a tsconfig paths alias', '@lib/helper', 'lib/helper.ts'],
    ['a tsconfig baseUrl import', 'lib/view', 'lib/view.tsx'],
  ])('resolves %s from TypeScript', (_case, specifier, file) => {
    const { asked } = resolveFrom(url('tests/example.e2e.ts'), specifier);
    expect(asked).toEqual([url(file)]);
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

  it.each([
    ['a # import naming ./x.js', 'tests/example.e2e.ts', '#internal/sub', 'internal/sub.js', 'internal/sub.ts'],
    ['an extensionless import from JavaScript', 'tests/plain.js', '../lib/helper', 'lib/helper', 'lib/helper.ts'],
    ['a directory import from JavaScript', 'tests/plain.js', '../lib/dir', 'lib/dir', 'lib/dir/index.ts'],
  ])('retries %s Node.js could not find on the TypeScript file behind it', (_case, parent, specifier, missing, file) => {
    expect(resolveFrom(url(parent), specifier, { missing: url(missing) }).asked).toEqual([specifier, url(file)]);
  });

  it('leaves a missing file with no TypeScript behind it, and one an installed package names, to fail as Node.js reports it', () => {
    expect(() => resolveFrom(url('tests/example.e2e.ts'), '#internal/gone', { missing: url('internal/gone.js') })).toThrow("Cannot find module");
    expect(() => resolveFrom(url('node_modules/dep/index.ts'), '#dep/helper', { missing: url('node_modules/dep/helper.js') })).toThrow("Cannot find module");
  });

  it('keeps the query and hash of the specifier', () => {
    const { asked } = resolveFrom(url('tests/example.e2e.ts'), '../lib/helper?v=1#x');
    expect(asked).toEqual([`${url('lib/helper.ts')}?v=1#x`]);
  });

  it.each([
    ['a file that exists as written', 'tests/example.e2e.ts', '../lib/only.js'],
    ['a missing file, for Node.js to report', 'tests/example.e2e.ts', '../lib/missing.js'],
    ['a relative import from JavaScript', 'tests/plain.js', '../lib/helper'],
    ['a # import', 'tests/example.e2e.ts', '#lib/helper'],
    ['a builtin a paths pattern could match', 'tests/example.e2e.ts', 'fs'],
    ['a package no alias names', 'tests/example.e2e.ts', 'dep'],
    ['a path inside an installed package', 'node_modules/dep/index.ts', './helper'],
    ['an alias from an installed package', 'node_modules/dep/index.ts', '@lib/helper'],
  ])('leaves %s to Node.js', (_case, parent, specifier) => {
    expect(resolveFrom(url(parent), specifier).asked).toEqual([specifier]);
  });

  it.each([
    ['.ts', 'lib/helper.ts', 'commonjs-typescript', 'module'],
    ['.tsx', 'lib/view.tsx', null, 'module'],
    ['.mts', 'lib/esm.mts', 'module-typescript', 'module'],
    ['.cts', 'lib/cjs.cts', 'commonjs-typescript', 'commonjs'],
    ['installed .ts', 'node_modules/dep/index.ts', 'commonjs', 'module'],
  ])('runs %s as %s whatever the package scope says', (_case, file, format, expected) => {
    expect(resolveFrom(undefined, url(file), { format }).resolution).toEqual({ url: url(file), format: expected });
  });

  it.each([
    ['JavaScript', 'file:///app/a.js', 'commonjs'],
    ['a builtin', 'node:path', 'builtin'],
    ['a data: URL', 'data:text/javascript,export%20{}', null],
  ])('leaves the format of %s alone', (_case, specifier, format) => {
    expect(resolveFrom(undefined, specifier, { format }).resolution).toEqual({ url: specifier, format });
  });

  it('resolves the helpers compiled code imports from e2e itself', () => {
    let parent: string | undefined;
    resolve('@oxc-project/runtime/helpers/decorate', { conditions: IMPORT, importAttributes: {}, parentURL: url('tests/example.e2e.ts') }, (specifier, context) => {
      parent = context?.parentURL;
      return { url: `file:///e2e/node_modules/${specifier}.js` };
    });
    expect(parent).toMatch(/\/src\/config\/esm-hooks\.ts$/);
  });

  it('resolves the helpers compiled CommonJS requires to the copy e2e installs, by path', () => {
    const { asked } = resolveFrom(url('lib/cjs.cts'), '@oxc-project/runtime/helpers/decorate', { conditions: REQUIRE });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/[\\/]@oxc-project[\\/]runtime[\\/]src[\\/]helpers[\\/]decorate\.js$/);
  });

  it('leaves a require() out of fresh graphs, which CommonJS cannot load twice', () => {
    const fromGraph = `${url('lib/cjs.cts')}?e2e=module-3&e2e-graph=module-3`;
    expect(resolveFrom(fromGraph, './helper', { conditions: REQUIRE }).resolution.url).toBe(url('lib/helper.ts'));
  });
});

describe('inGraph', () => {
  const parent = 'file:///app/e2e.agent.config.ts?e2e=module-3&e2e-graph=module-3';

  it.each([
    ['a relative import', './e2e.config.ts', 'file:///app/e2e.config.ts'],
    ['a parent-relative import', '../shared/targets.ts', 'file:///shared/targets.ts'],
    ['an absolute path', '/app/targets.ts', 'file:///app/targets.ts'],
    ['a file: URL', 'file:///app/src/targets.ts', 'file:///app/src/targets.ts'],
    ['a # subpath import', '#targets', 'file:///app/src/targets.ts'],
  ])('hands the graph on to %s', (_case, specifier, target) => {
    expect(inGraph(specifier, { parentURL: parent }, { url: target, format: 'module' })).toEqual({
      url: `${target}?e2e-graph=module-3`,
      format: 'module',
    });
  });

  it('keeps the query a resolution already carries', () => {
    expect(inGraph('./a.ts', { parentURL: parent }, { url: 'file:///app/a.ts?v=1', format: 'module' }).url).toBe(
      'file:///app/a.ts?v=1&e2e-graph=module-3',
    );
  });

  it.each([
    ['a package by name', '@e2e-dev/web', parent, 'file:///work/packages/web/dist/index.js'],
    ['a file under node_modules', './lib.js', 'file:///app/node_modules/dep/index.js?e2e-graph=module-3', 'file:///app/node_modules/dep/lib.js'],
    ['an importer outside any graph', './e2e.config.ts', 'file:///app/e2e.agent.config.ts?e2e=module-1', 'file:///app/e2e.config.ts'],
    ['the entry, which has no importer', 'file:///app/e2e.config.ts', undefined, 'file:///app/e2e.config.ts'],
    ['a builtin', 'node:path', parent, 'node:path'],
  ])('leaves %s alone', (_case, specifier, parentURL, target) => {
    const resolution = { url: target, format: 'module' };
    expect(inGraph(specifier, { parentURL }, resolution)).toBe(resolution);
  });

  it('hands the graph on to a tsconfig alias the loader maps', () => {
    const fromGraph = `${url('e2e.config.ts')}?e2e=module-3&e2e-graph=module-3`;
    expect(resolveFrom(fromGraph, '@lib/helper', { format: 'module' }).resolution.url).toBe(`${url('lib/helper.ts')}?e2e-graph=module-3`);
  });

  it('runs inside the resolve hook', () => {
    expect(resolveFrom(parent, './e2e.config.ts', { format: 'module' }).resolution).toEqual({
      url: 'file:///app/e2e.config.ts?e2e-graph=module-3',
      format: 'module',
    });
  });
});

describe('load', () => {
  const context = (overrides: Partial<LoadHookContext> = {}): LoadHookContext => ({
    conditions: ['node', 'import'],
    format: undefined,
    importAttributes: {},
    ...overrides,
  });
  const passThrough = () => ({ format: 'next', source: 'next' });

  it('compiles TypeScript for the format its extension calls for', () => {
    write({ 'lib/typed.ts': 'export const n: number = 1;\n', 'lib/typed.cts': 'const n: number = 1;\nmodule.exports = n;\n' });
    const esm = load(`${url('lib/typed.ts')}?e2e=collect-1`, context(), passThrough);
    expect(esm).toMatchObject({ format: 'module', shortCircuit: true });
    expect(String(esm.source)).toMatch(/^export const n = 1;\n/);
    const cjs = load(url('lib/typed.cts'), context({ conditions: ['node', 'require'] }), passThrough);
    expect(cjs).toMatchObject({ format: 'commonjs' });
    expect(String(cjs.source)).toMatch(/\nconst n = 1;\nmodule\.exports = n;\n/);
  });

  it('loads JSON imported without a type attribute as a module exporting the parsed file', async () => {
    write({ 'lib/settings.json': '\uFEFF{ "__proto__": { "polluted": true }, "answer": 42 }' });
    const loaded = load(url('lib/settings.json'), context(), passThrough);
    expect(loaded.format).toBe('module');
    const module = (await import(`data:text/javascript,${encodeURIComponent(String(loaded.source))}`)) as { default: Record<string, unknown> };
    expect(module.default['answer']).toBe(42);
    expect(Object.getPrototypeOf(module.default)).toBe(Object.prototype);
  });

  it.each([
    ['JSON with a type attribute', 'lib/data.json', context({ importAttributes: { type: 'json' } })],
    ['JSON a require() reads', 'lib/data.json', context({ conditions: ['node', 'require'] })],
    ['JavaScript', 'lib/only.js', context()],
  ])('hands %s to Node.js', (_case, file, loadContext) => {
    expect(load(url(file), loadContext, passThrough)).toEqual({ format: 'next', source: 'next' });
  });
});
