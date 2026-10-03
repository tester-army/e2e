/**
 * Records the engine versions `e2e init` installs, read from
 * the sibling packages' manifests at build time.
 *
 * Usage: `node scripts/write-sibling-versions.ts`, from the package directory,
 * after `tsc` emitted `dist`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

type Manifest = { version: string };

const read = (dir: string) => JSON.parse(readFileSync(`../${dir}/package.json`, 'utf8')) as Manifest;

const versions = {
  '@e2e-dev/web': read('web').version,
  '@e2e-dev/mobile': read('mobile').version,
};
writeFileSync('dist/cli/init/sibling-versions.json', `${JSON.stringify(versions)}\n`);
