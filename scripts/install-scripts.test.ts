import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findInstallScripts } from './install-scripts.ts';

const root = mkdtempSync(join(tmpdir(), 'install-scripts-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Writes a package at `dir` with `manifest` and any extra files. */
function pkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  return path;
}

describe('findInstallScripts', () => {
  it('finds install scripts and native builds anywhere in the tree, by the chain that brings them in', () => {
    const app = pkg('app', {
      name: 'app',
      scripts: { build: 'tsc', prepublishOnly: 'check' },
      dependencies: { loader: '1', 'native-both': '1' },
      optionalDependencies: { 'native-other-os': '1', 'native-both': '1' },
      peerDependencies: { peer: '1', 'optional-peer': '1' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    });
    pkg('app/node_modules/loader', { name: 'loader', dependencies: { bundler: '1', shared: '1' } });
    pkg('store/bundler', { name: 'bundler', version: '0.28.2', scripts: { postinstall: 'node install.js' }, dependencies: { shared: '1' } });
    // pnpm's layout: the real directory elsewhere, a link in node_modules.
    mkdirSync(join(root, 'app/node_modules/loader/node_modules'), { recursive: true });
    symlinkSync(join(root, 'store/bundler'), join(root, 'app/node_modules/loader/node_modules/bundler'), 'junction');
    pkg('node_modules/shared', { name: 'shared' });
    pkg('node_modules/peer', { name: 'peer' }, { 'binding.gyp': '{}' });

    assert.deepEqual(findInstallScripts(app), [
      { chain: 'app > peer@1.0.0', runs: 'node-gyp rebuild (binding.gyp)' },
      { chain: 'app > loader@1.0.0 > bundler@0.28.2', runs: 'postinstall: node install.js' },
    ]);
  });

  it('finds an install script of the package itself', () => {
    const own = pkg('own', { name: 'own', scripts: { postinstall: 'node setup.js' } });
    assert.deepEqual(findInstallScripts(own), [{ chain: 'own', runs: 'postinstall: node setup.js' }]);
  });

  it('refuses a tree with a required dependency missing', () => {
    const lonely = pkg('lonely', { name: 'lonely', dependencies: { absent: '1' } });
    assert.throws(() => findInstallScripts(lonely), /lonely > absent is not installed/);
  });
});
