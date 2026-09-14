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
 *
 * Usage: `node scripts/canary-changeset.ts`, right before
 * `changeset version --snapshot canary`. The file it writes is git-ignored and
 * consumed by that command.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const CHANGESET = join(ROOT, '.changeset', 'canary.md');

const names: string[] = [];
for (const dir of readdirSync(PACKAGES)) {
  let manifest: { name?: string; private?: boolean };
  try {
    manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    continue;
  }
  if (manifest.private === true || manifest.name === undefined) continue;
  names.push(manifest.name);
}

if (names.length === 0) {
  console.error('no publishable package under packages/');
  process.exit(1);
}

const frontmatter = names.toSorted().map((name) => `"${name}": patch`).join('\n');
writeFileSync(CHANGESET, `---\n${frontmatter}\n---\n\nCanary build.\n`);
console.log(`wrote .changeset/canary.md for ${names.join(', ')}`);
