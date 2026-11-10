import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEngine } from '../../src/mcp/default-engine.ts';

/** A module whose default export returns what `defineEngine` brands, carrying the options it was called with. */
const FACTORY = `export default (options) => ({ [Symbol.for('e2e.engine.v1')]: true, spiVersion: 1, name: 'fake', options });\n`;

let root: string;
let lookup: { cwd: string; enginesDir: string };

/** Installs `name` under `dir/node_modules` with `source` as its entry, and `subpaths` as further entries. */
function install(dir: string, name: string, source: string, subpaths: Readonly<Record<string, string>> = {}): void {
  const packageDir = path.join(dir, 'node_modules', name);
  mkdirSync(packageDir, { recursive: true });
  const exports = Object.fromEntries([['.', { default: './index.js' }], ...Object.keys(subpaths).map((subpath) => [`./${subpath}`, { default: `./${subpath}.js` }])]);
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, type: 'module', exports }));
  writeFileSync(path.join(packageDir, 'index.js'), source);
  for (const [subpath, content] of Object.entries(subpaths)) writeFileSync(path.join(packageDir, `${subpath}.js`), content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'e2e-default-engine-'));
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
  });

  it('keeps a __proto__ key from JSON an own property, so it cannot give the options inherited values', async () => {
    install(lookup.cwd, 'engine', FACTORY);
    const options = JSON.parse('{"platform":"ios","__proto__":{"device":"smuggled"}}') as Record<string, unknown>;
    const engine = (await loadEngine({ package: 'engine', options }, lookup)) as unknown as { options: Record<string, unknown> };
    expect(Object.getPrototypeOf(engine.options)).toBe(Object.prototype);
    expect(engine.options['device']).toBeUndefined();
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
      message: expect.stringContaining('package absent-cloud is not installed'),
    });
  });

  it.each(['./engine.js', '/tmp/engine.js', 'file:///tmp/engine.js', 'engine/../../outside', '..'])('refuses %s, which is not a package name', async (name) => {
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
