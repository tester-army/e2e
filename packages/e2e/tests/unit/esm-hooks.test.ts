import { describe, expect, it } from 'vitest';
import { asModule, inGraph, resolve, resolveSync } from '../../src/config/esm-hooks.ts';
import { tsxUsesSyncHooks } from '../../src/config/load.ts';

const context = { conditions: [], importAttributes: {}, parentURL: undefined };
const underTsx = { parentURL: 'file:///app/tests/example.e2e.ts?e2e=collect-1&tsx-namespace=e2e' };

describe('asModule', () => {
  it.each([
    ['the config entry in a typeless package', 'file:///app/e2e.config.ts?e2e=module-1', undefined],
    ['a CommonJS-scoped test', 'file:///app/tests/example.e2e.ts', 'commonjs-typescript'],
    ['a .tsx helper', 'file:///app/tests/helper.tsx', 'commonjs'],
    ['an .mts file Node left untyped', 'file:///app/e2e.config.mts', null],
  ])('marks %s as an ES module', (_case, url, format) => {
    expect(asModule(url, context, { url, format })).toEqual({ url, format: 'module' });
  });

  it.each([
    ['./helper.ts', 'file:///app/tests/helper.ts'],
    ['../shared/seed.ts', 'file:///app/shared/seed.ts'],
    ['/app/tests/helper.ts', 'file:///app/tests/helper.ts'],
    // A tsconfig paths alias, as tsx passes it on Windows: pathToFileURL of the mapped path.
    ['file:///C:/app/src/lib/seed.ts', 'file:///C:/app/src/lib/seed.ts'],
  ])('marks a file reached by the path %s as an ES module', (specifier, url) => {
    const resolution = { url, format: 'commonjs-typescript' };
    expect(asModule(specifier, context, resolution)).toEqual({ ...resolution, format: 'module' });
  });

  it.each([
    ['a linked package shipping TypeScript source', 'cjs-helper', { url: 'file:///work/cjs-helper/index.ts', format: 'commonjs-typescript' }],
    ['a workspace package export', '@scope/core/shared/months', { url: 'file:///work/core/src/shared/months.ts', format: 'commonjs' }],
    ['a subpath import', '#internal/helper', { url: 'file:///app/src/helper.ts', format: 'commonjs' }],
  ])('marks TypeScript outside node_modules reached through %s as an ES module', (_case, specifier, resolution) => {
    expect(asModule(specifier, underTsx, resolution)).toEqual({ ...resolution, format: 'module' });
  });

  it.each([
    ['an ES module', './a.ts', { url: 'file:///app/a.ts', format: 'module' }],
    ['module-typescript', './a.ts', { url: 'file:///app/a.ts', format: 'module-typescript' }],
    ['a .cts file', './a.cts', { url: 'file:///app/a.cts', format: 'commonjs' }],
    ['JavaScript', './a.js', { url: 'file:///app/a.js', format: 'commonjs' }],
    ['an installed package', 'dep', { url: 'file:///app/node_modules/dep/index.ts', format: 'commonjs' }],
    ['a scoped installed package', '@scope/dep', { url: 'file:///app/node_modules/@scope/dep/src/index.ts', format: 'commonjs' }],
    ['a builtin', 'node:path', { url: 'node:path', format: 'builtin' }],
    ['a data: URL', 'data:text/javascript,export%20{}', { url: 'data:text/javascript,export%20{}', format: undefined }],
  ])('leaves %s alone', (_case, specifier, resolution) => {
    expect(asModule(specifier, underTsx, resolution)).toBe(resolution);
  });

  it.each([
    ['a .cjs helper', 'file:///app/tests/required.cjs'],
    ['a module Node loaded itself', 'file:///work/core/src/shared/months.ts'],
    ['another tsx namespace', 'file:///app/tests/example.ts?tsx-namespace=other'],
  ])('leaves a workspace package that %s reaches alone, so Node strips its types', (_case, parentURL) => {
    const resolution = { url: 'file:///work/core/src/shared/pad.ts', format: 'commonjs-typescript' };
    expect(asModule('#shared/pad', { parentURL }, resolution)).toBe(resolution);
  });

  it('serves both hook kinds', async () => {
    const next = (specifier: string) => ({ url: `file:///app/${specifier.slice(2)}`, format: 'commonjs-typescript' });
    expect(resolveSync('./a.ts', context, next)).toEqual({ url: 'file:///app/a.ts', format: 'module' });
    await expect(resolve('./a.ts', context, async (specifier) => next(specifier))).resolves.toEqual({
      url: 'file:///app/a.ts',
      format: 'module',
    });
  });
});

describe('inGraph', () => {
  const parent = 'file:///app/e2e.agent.config.ts?e2e=module-3&e2e-graph=module-3';

  it.each([
    ['a relative import', './e2e.config.ts', 'file:///app/e2e.config.ts'],
    ['a parent-relative import', '../shared/targets.ts', 'file:///shared/targets.ts'],
    ['an absolute path', '/app/targets.ts', 'file:///app/targets.ts'],
    ['a file: URL, as tsx passes a paths alias', 'file:///app/src/targets.ts', 'file:///app/src/targets.ts'],
    ['a # subpath import', '#targets', 'file:///app/src/targets.ts'],
  ])('hands the graph on to %s', (_case, specifier, url) => {
    expect(inGraph(specifier, { parentURL: parent }, { url, format: 'module' })).toEqual({ url: `${url}?e2e-graph=module-3`, format: 'module' });
  });

  it('keeps the query a resolution already carries', () => {
    expect(inGraph('./a.ts', { parentURL: parent }, { url: 'file:///app/a.ts?tsx-namespace=e2e', format: 'module' }).url).toBe(
      'file:///app/a.ts?tsx-namespace=e2e&e2e-graph=module-3',
    );
  });

  it.each([
    ['a package by name', '@e2e-dev/web', parent, 'file:///work/packages/web/dist/index.js'],
    ['a file under node_modules', './lib.js', 'file:///app/node_modules/dep/index.js?e2e-graph=module-3', 'file:///app/node_modules/dep/lib.js'],
    ['an importer outside any graph', './e2e.config.ts', 'file:///app/e2e.agent.config.ts?e2e=module-1', 'file:///app/e2e.config.ts'],
    ['the entry, which has no importer', 'file:///app/e2e.config.ts', undefined, 'file:///app/e2e.config.ts'],
    ['a builtin', 'node:path', parent, 'node:path'],
  ])('leaves %s alone', (_case, specifier, parentURL, url) => {
    const resolution = { url, format: 'module' };
    expect(inGraph(specifier, { parentURL }, resolution)).toBe(resolution);
  });

  it('runs in both hook kinds', async () => {
    const fromGraph = { ...context, parentURL: parent };
    const next = () => ({ url: 'file:///app/e2e.config.ts', format: 'module' });
    const expected = { url: 'file:///app/e2e.config.ts?e2e-graph=module-3', format: 'module' };
    expect(resolveSync('./e2e.config.ts', fromGraph, next)).toEqual(expected);
    await expect(resolve('./e2e.config.ts', fromGraph, async () => next())).resolves.toEqual(expected);
  });
});

describe('tsxUsesSyncHooks', () => {
  it.each([
    ['22.12.0', false],
    ['22.22.2', false],
    ['22.22.3', true],
    ['23.11.0', false],
    ['24.11.0', false],
    ['24.11.1', true],
    ['25.0.0', false],
    ['25.1.0', true],
    ['26.0.0', true],
    ['27.2.0', true],
  ])('on Node.js %s registers like tsx: sync=%s', (version, expected) => {
    expect(tsxUsesSyncHooks(version, true, '')).toBe(expected);
  });

  it('needs module.registerHooks', () => {
    expect(tsxUsesSyncHooks('26.4.0', false, '')).toBe(false);
  });

  it.each(['--import ./setup.ts', '--import=./setup.mts', '--require x --import tsx/esm --import ./a.tsx?x=1'])(
    'follows tsx to async hooks with %s in NODE_OPTIONS',
    (nodeOptions) => {
      expect(tsxUsesSyncHooks('26.4.0', true, nodeOptions)).toBe(false);
    },
  );

  it('keeps sync hooks with a JavaScript --import', () => {
    expect(tsxUsesSyncHooks('26.4.0', true, '--import ./setup.mjs --import tsx/esm')).toBe(true);
  });
});
