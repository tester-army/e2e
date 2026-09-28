import { describe, expect, it } from 'vitest';
import { asModule, resolve, resolveSync } from '../../src/config/esm-hooks.ts';
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
