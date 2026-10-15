/**
 * Fails when a pending changeset bumps a `0.x` package by `minor` without a
 * summary opening `**Breaking:**` or `**Release:**`, or by `major` without
 * `**Release:**` (`changeset-bumps.ts` says why).
 *
 * Usage: `node scripts/check-changeset-bumps.ts`, part of `pnpm check`. Exits
 * 1 listing every offending changeset.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseChangesetFile } from '@changesets/parse';
import { BREAKING, RELEASE, disallowedBumps } from './changeset-bumps.ts';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

const versions = new Map(publicPackages().flatMap(({ manifest }) => (manifest.version === undefined ? [] : [[manifest.name, manifest.version] as const])));
const dir = join(REPO_ROOT, '.changeset');
const files = readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md');
const problems: string[] = [];
for (const file of files.toSorted()) {
  for (const { name, type } of disallowedBumps(parseChangesetFile(readFileSync(join(dir, file), 'utf8')), versions)) {
    const needs = type === 'major' ? RELEASE : `${BREAKING} or ${RELEASE}`;
    problems.push(`.changeset/${file}: ${type} bump of ${name} ${versions.get(name)}; on 0.x a feature or fix is a patch, and a ${type} needs a summary opening with ${needs}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`changeset bumps: ${files.length} pending, none an unannounced 0.x minor or major\n`);
}
