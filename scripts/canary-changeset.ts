/**
 * Writes one changeset that bumps every publishable package, so a canary
 * moves them all together.
 *
 * A snapshot release only versions the packages that have a pending changeset
 * (plus their dependents). A merge that touches one engine alone would publish
 * a canary of that engine whose peer range still names the last stable runner,
 * while the `canary` dist-tag of the runner points at a prerelease that range
 * rejects. Bumping all of them rewrites every peer range to the runner's exact
 * canary version and lets `init` pin engines that match the runner it ships in.
 * That pin is for the tarballs only: `restore-peer-ranges.ts` widens it again
 * after the publish, before the output is committed.
 *
 * Usage: `node scripts/canary-changeset.ts`, right before
 * `changeset version --snapshot canary`. The file it writes is git-ignored and
 * consumed by that command.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

const CHANGESET = join(REPO_ROOT, '.changeset', 'canary.md');

const names = publicPackages().map(({ manifest }) => manifest.name);

if (names.length === 0) {
  console.error('no publishable package under packages/');
  process.exit(1);
}

const frontmatter = names.toSorted().map((name) => `"${name}": patch`).join('\n');
writeFileSync(CHANGESET, `---\n${frontmatter}\n---\n\nCanary build.\n`);
console.log(`wrote .changeset/canary.md for ${names.join(', ')}`);
