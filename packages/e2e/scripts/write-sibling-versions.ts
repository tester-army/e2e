/**
 * Records the engine and Playwright versions `e2e init` installs, read from
 * the sibling packages' manifests at build time.
 *
 * Usage: `node scripts/write-sibling-versions.ts`, from the package directory,
 * after `tsc` emitted `dist`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

type Manifest = { version: string; devDependencies: { playwright: string } };

const read = (dir: string) => JSON.parse(readFileSync(`../${dir}/package.json`, 'utf8')) as Manifest;

const web = read('web');
const versions = {
  '@e2e-dev/web': web.version,
  '@e2e-dev/mobile': read('mobile').version,
  playwright: web.devDependencies.playwright,
};
writeFileSync('dist/cli/init/sibling-versions.json', `${JSON.stringify(versions)}\n`);
