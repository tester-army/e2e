import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEngine } from '../../src/mcp/default-engine.ts';

/** A module whose default export returns what `defineEngine` brands, carrying the options it was called with. */
const FACTORY = `export default (options) => ({ [Symbol.for('e2e.engine.v1')]: true, spiVersion: 1, name: 'fake', options });\n`;

let root: string;
let lookup: { cwd: string; enginesDir: string };

/** Installs `name` under `dir/node_modules` with `source` as its entry, and `subpaths` as further entries, each exported under `condition`. */
function install(dir: string, name: string, source: string, subpaths: Readonly<Record<string, string>> = {}, condition = 'default'): void {
  const packageDir = path.join(dir, 'node_modules', name);
  mkdirSync(packageDir, { recursive: true });
  const exports = Object.fromEntries([['.', { types: './index.d.ts', [condition]: './index.js' }], ...Object.keys(subpaths).map((subpath) => [`./${subpath}`, { [condition]: `./${subpath}.js` }])]);
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, type: 'module', exports }));
  writeFileSync(path.join(packageDir, 'index.js'), source);
  for (const [subpath, content] of Object.entries(subpaths)) writeFileSync(path.join(packageDir, `${subpath}.js`), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'e2e-default-engine-')));
  lookup = { cwd: path.join(root, 'project'), enginesDir: path.join(root, 'engines') };
  mkdirSync(lookup.cwd);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadEngine', () => {
  it("calls the default export of the project's package with the options", async () => {
    install(lookup.cwd, '@acme/engine', FACTORY);
    const engine = await loadEngine({ package: '@acme/engine', options: { platform: 'ios' } }, lookup);
    expect(engine).toMatchObject({ name: 'fake', options: { platform: 'ios' } });
  });

  it('calls a named export, and one on a subpath', async () => {
    install(lookup.cwd, 'named', FACTORY.replace('export default', 'export const kiosk ='), { web: FACTORY.replace("'fake'", "'from-subpath'") });
    expect(await loadEngine({ package: 'named', export: 'kiosk' }, lookup)).toMatchObject({ name: 'fake' });
    expect(await loadEngine({ package: 'named/web' }, lookup)).toMatchObject({ name: 'from-subpath' });
  });

  it('loads a package that exports its entries to import alone', async () => {
    install(lookup.cwd, 'esm-only', FACTORY, { web: FACTORY.replace("'fake'", "'from-subpath'") }, 'import');
    expect(await loadEngine({ package: 'esm-only' }, lookup)).toMatchObject({ name: 'fake' });
    expect(await loadEngine({ package: 'esm-only/web' }, lookup)).toMatchObject({ name: 'from-subpath' });
  });

  it.each([
    ['dual', 'import'],
    ['dual/web', 'import'],
    ['dual', 'require'],
    ['dual/web', 'require'],
  ])('loads the import entry of %s when %s is declared first', async (specifier, first) => {
    const dir = path.join(lookup.cwd, 'node_modules', 'dual');
    mkdirSync(dir, { recursive: true });
    const entry = (base: string) => first === 'import' ? { import: `./${base}.js`, require: `./${base}.cjs` } : { require: `./${base}.cjs`, import: `./${base}.js` };
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dual', version: '0.0.0', type: 'module', exports: { '.': entry('index'), './web': entry('web') } }));
    for (const base of ['index', 'web']) {
      writeFileSync(path.join(dir, `${base}.js`), FACTORY.replace("'fake'", "'esm'"));
      writeFileSync(path.join(dir, `${base}.cjs`), FACTORY.replace('export default', 'module.exports =').replace("'fake'", "'cjs'"));
    }
    expect(await loadEngine({ package: specifier }, lookup)).toMatchObject({ name: 'esm' });
  });

  it.each([null, './missing.js', '../outside.js'])('rejects an import target of %s without bypassing it for require', async (target) => {
    const dir = path.join(lookup.cwd, 'node_modules', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'broken', type: 'module', exports: { import: target, require: './index.cjs' } }));
    writeFileSync(path.join(dir, 'index.cjs'), FACTORY.replace('export default', 'module.exports ='));
    await expect(loadEngine({ package: 'broken' }, lookup)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('but its entry cannot be resolved') });
  });

  it('loads a legacy CommonJS package with a main entry', async () => {
    const dir = path.join(lookup.cwd, 'node_modules', 'legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'legacy', version: '0.0.0', main: 'index.cjs' }));
    writeFileSync(path.join(dir, 'index.cjs'), FACTORY.replace('export default', 'module.exports =').replace("'fake'", "'legacy'"));
    expect(await loadEngine({ package: 'legacy' }, lookup)).toMatchObject({ name: 'legacy' });
  });

  it('makes the factory calls among the options first, so an engine gets a provider JSON cannot carry', async () => {
    install(lookup.cwd, 'engine', FACTORY);
    install(lookup.enginesDir, 'cloud', `export const devices = (options) => ({ name: 'cloud', region: options?.region, acquire: () => 'leased' });\n`);
    const engine = (await loadEngine(
      { package: 'engine', options: { platform: 'ios', device: { package: 'cloud', export: 'devices', options: { region: 'eu' } }, pool: [{ package: 'cloud', export: 'devices' }], app: { package: 'left alone', bundleId: 'x' } } },
      lookup,
    )) as unknown as { options: { device: { region: string; acquire: () => string }; pool: { name: string }[]; app: unknown } };
    expect(engine.options.device.region).toBe('eu');
    expect(engine.options.device.acquire()).toBe('leased');
    expect(engine.options.pool[0]?.name).toBe('cloud');
    // An object with any other key is an option value, not a factory call.
    expect(engine.options.app).toEqual({ package: 'left alone', bundleId: 'x' });
    // Nor is the options object itself, whatever its keys.
    expect(await loadEngine({ package: 'engine', options: { package: 'com.example.app' } }, lookup)).toMatchObject({ options: { package: 'com.example.app' } });
  });

  it('keeps a __proto__ key from JSON an own property, so it cannot give the options inherited values', async () => {
    install(lookup.cwd, 'engine', FACTORY);
    const options = JSON.parse('{"platform":"ios","__proto__":{"device":"smuggled"}}') as Record<string, unknown>;
    const engine = (await loadEngine({ package: 'engine', options }, lookup)) as unknown as { options: Record<string, unknown> };
    expect(Object.getPrototypeOf(engine.options)).toBe(Object.prototype);
    expect(engine.options['device']).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(engine.options, '__proto__')?.value).toEqual({ device: 'smuggled' });
  });

  it('falls back to the engines directory, and prefers the project', async () => {
    install(lookup.enginesDir, 'shared-engine', FACTORY);
    expect(await loadEngine({ package: 'shared-engine' }, lookup)).toMatchObject({ name: 'fake' });

    install(lookup.enginesDir, 'both', FACTORY.replace("'fake'", "'from-engines-dir'"));
    install(lookup.cwd, 'both', FACTORY.replace("'fake'", "'from-project'"));
    expect(await loadEngine({ package: 'both' }, lookup)).toMatchObject({ name: 'from-project' });
  });

  it('names the install command for a package that is nowhere, the engine or one of its options', async () => {
    await expect(loadEngine({ package: '@acme/absent/web' }, lookup)).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
      message: expect.stringContaining(`npm install --prefix ${JSON.stringify(lookup.enginesDir)} @acme/absent;`),
    });
    install(lookup.cwd, 'engine', FACTORY);
    await expect(loadEngine({ package: 'engine', options: { device: { package: 'absent-cloud' } } }, lookup)).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
      message: expect.stringContaining('is read as a factory call, and package absent-cloud is not installed'),
    });
  });

  it('reports a package that is installed without a loadable entry, and looks no further for it', async () => {
    install(lookup.cwd, 'unbuilt', FACTORY);
    rmSync(path.join(lookup.cwd, 'node_modules', 'unbuilt', 'index.js'));
    install(lookup.enginesDir, 'unbuilt', FACTORY);
    await expect(loadEngine({ package: 'unbuilt' }, lookup)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining(`is installed at ${path.join(lookup.cwd, 'node_modules', 'unbuilt')} but its entry cannot be resolved`),
    });
  });

  it.each(['./engine.js', '/tmp/engine.js', 'file:///tmp/engine.js', 'engine/../../outside', '..', 'util', 'fs/promises', 'node:fs'])('refuses %s, which is not an installed package', async (name) => {
    await expect(loadEngine({ package: name }, lookup)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses an export that is no factory, one that returns no engine, and an engine on another contract', async () => {
    install(lookup.cwd, 'named-only', `export const engine = () => ({});\nexport const limit = 3;\n`);
    install(lookup.cwd, 'not-an-engine', `export default () => ({ name: 'plain object' });\n`);
    install(lookup.cwd, 'old-contract', FACTORY.replace('spiVersion: 1', 'spiVersion: 0'));
    await expect(loadEngine({ package: 'named-only' }, lookup)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('is not a function, so there is nothing to call; its functions: engine. Name one with export'),
    });
    await expect(loadEngine({ package: 'named-only', export: 'constructor.prototype' }, lookup)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(loadEngine({ package: 'not-an-engine' }, lookup)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('did not return an engine') });
    await expect(loadEngine({ package: 'old-contract' }, lookup)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('engine contract 0') });
  });
});

describe('loadEngine runtime export conditions', () => {
  it.each([
    { label: 'the defaults', condition: 'module-sync', flags: [], env: {}, expected: 'native' },
    { label: '--no-experimental-require-module', condition: 'module-sync', flags: ['--no-experimental-require-module'], env: {}, expected: 'fallback' },
    { label: '--no-addons', condition: 'node-addons', flags: ['--no-addons'], env: {}, expected: 'fallback' },
    { label: 'NODE_OPTIONS=--no-addons', condition: 'node-addons', flags: [], env: { NODE_OPTIONS: '--no-addons' }, expected: 'fallback' },
  ])('loads what native import resolves under $label', ({ condition, flags, env, expected }) => {
    const dir = path.join(lookup.cwd, 'node_modules', 'cond');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cond', type: 'module', exports: { [condition]: './native.js', default: './fallback.js' } }));
    for (const name of ['native', 'fallback']) writeFileSync(path.join(dir, name + '.js'), FACTORY.replace('fake', name));
    const program = [
      'const { loadEngine } = await import(process.argv[1]);',
      'const native = (await import("cond")).default({}).name;',
      'const loaded = (await loadEngine({ package: "cond" }, { cwd: process.cwd(), enginesDir: process.cwd() })).name;',
      'console.log(JSON.stringify({ native, loaded }));',
    ].join('\n');
    const loader = new URL('../../src/mcp/default-engine.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', program, '--', loader], { cwd: lookup.cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ...env } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ native: expected, loaded: expected });
  });
});

describe('loadEngine nested export conditions', () => {
  const NESTED: [string, Record<string, unknown>, string | null][] = [
    ['subpath/web', { '.': { import: './outer.js' }, './web': { node: { require: './inner.cjs' }, import: './other.js' } }, 'other'],
    ['deep', { '.': { node: { default: { require: './inner.cjs' } }, import: './outer.js' } }, 'outer'],
    ['array', { '.': { node: [{ require: './inner.cjs' }, { custom: './other.js' }], import: './outer.js' } }, 'outer'],
    ['inner-require', { '.': { node: { require: './inner.cjs' }, import: './outer.js' } }, 'outer'],
    ['inner-null', { '.': { node: { require: null }, import: './outer.js' } }, 'outer'],
    ['active-null', { '.': { node: { import: null }, default: './outer.js' } }, null],
    ['null-array', { '.': { node: [null], import: './outer.js' } }, null],
    ['empty-array', { '.': { node: [], import: './outer.js' } }, null],
    ['blocked-subpath/web', { '.': { import: './outer.js' }, './web': null }, null],
    ['node-addons', { '.': { 'node-addons': './other.js', import: './outer.js' } }, 'other'],
    ['require-only', { '.': { require: './inner.cjs' } }, null],
  ];

  const PROGRAM = [
    'const { loadEngine } = await import(process.argv[1]);',
    'const spec = process.argv[2];',
    'const lookup = { cwd: process.cwd(), enginesDir: process.cwd() };',
    'const native = await import(spec).then((m) => m.default({}).name, (e) => ({ code: e.code }));',
    'const loaded = await loadEngine({ package: spec }, lookup).then((e) => e.name, (e) => ({ code: e.code, message: e.message }));',
    'console.log(JSON.stringify({ native, loaded }));',
  ].join('\n');

  it.each(NESTED)('loads %s as a native import does', (spec, exports, expected) => {
    const name = spec.split('/')[0] ?? spec;
    const dir = path.join(lookup.cwd, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports }));
    writeFileSync(path.join(dir, 'outer.js'), FACTORY.replace('fake', 'outer'));
    writeFileSync(path.join(dir, 'other.js'), FACTORY.replace('fake', 'other'));
    writeFileSync(path.join(dir, 'inner.cjs'), FACTORY.replace('export default', 'module.exports =').replace('fake', 'inner'));
    const loader = new URL('../../src/mcp/default-engine.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', PROGRAM, '--', loader, spec], { cwd: lookup.cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(child.status, child.stderr).toBe(0);
    const { native, loaded } = JSON.parse(child.stdout.trim()) as { native: unknown; loaded: unknown };
    if (expected !== null) {
      expect(native).toBe(expected);
      expect(loaded).toBe(expected);
      return;
    }
    expect(native).toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    expect(loaded).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('package ' + spec + ' is installed at ' + dir + ' but its entry cannot be resolved') });
  });

  it('reports the first installed copy whose conditions block the entry, and looks no further for it', async () => {
    const dir = path.join(lookup.cwd, 'node_modules', 'refused');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'refused', type: 'module', exports: { '.': { node: { import: null }, default: './index.js' } } }));
    writeFileSync(path.join(dir, 'index.js'), FACTORY);
    install(lookup.enginesDir, 'refused', FACTORY);
    await expect(loadEngine({ package: 'refused' }, lookup)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('is installed at ' + dir + ' but its entry cannot be resolved'),
    });
  });

  it('resolves entries again after files or manifests change', async () => {
    install(lookup.cwd, 'late', FACTORY, {}, 'import');
    rmSync(path.join(lookup.cwd, 'node_modules', 'late', 'index.js'));
    await expect(loadEngine({ package: 'late' }, lookup)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    writeFileSync(path.join(lookup.cwd, 'node_modules', 'late', 'index.js'), FACTORY.replace('fake', 'late'));
    expect(await loadEngine({ package: 'late' }, lookup)).toMatchObject({ name: 'late' });

    const dir = path.join(lookup.cwd, 'node_modules', 'swap');
    mkdirSync(dir, { recursive: true });
    for (const name of ['a', 'b']) writeFileSync(path.join(dir, name + '.js'), FACTORY.replace('fake', name));
    const manifest = (entry: string) => JSON.stringify({ name: 'swap', type: 'module', exports: { '.': { import: './' + entry + '.js' } } });
    writeFileSync(path.join(dir, 'package.json'), manifest('a'));
    expect(await loadEngine({ package: 'swap' }, lookup)).toMatchObject({ name: 'a' });
    writeFileSync(path.join(dir, 'package.json'), manifest('b'));
    expect(await loadEngine({ package: 'swap' }, lookup)).toMatchObject({ name: 'b' });
  });
});
