/**
 * Fails when a pending changeset bumps a `0.x` package by `minor` without a
 * summary opening `**Breaking:**` or `**Release:**`, or by `major` without
 * `**Release:**` (`changeset-bumps.ts` says why), or when a changeset
 * raises a package's peer floor on a sibling past a runner minor the
 * previous range accepted without a `**Breaking:**` minor
 * (`floorRaiseProblems` in `changeset-bumps.ts` says how a raise is judged:
 * the previous floor is the one at the package's release tag, and only a
 * released version on an older minor counts).
 *
 * Usage: `node scripts/check-changeset-bumps.ts`, part of `pnpm check`. Exits
 * 1 listing every offending changeset.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseChangesetFile } from '@changesets/parse';
import { BREAKING, RELEASE, disallowedBumps, floorRaiseProblems, type FloorRaiseInput } from './changeset-bumps.ts';
import { peerFloor, releasedVersions } from './peer-ranges.ts';
import { REPO_ROOT, isWidePeerRange, publicPackages, siblingPeers, type PackageManifest } from './public-packages.ts';

/** Reads `path` at `tag` (`git show`), undefined when the tag or the file does not exist. */
function showAtTag(tag: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${tag}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

const versions = new Map(publicPackages().flatMap(({ manifest }) => (manifest.version === undefined ? [] : [[manifest.name, manifest.version] as const])));
const dir = join(REPO_ROOT, '.changeset');
const files = readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md');
const changesets = files.map((file) => parseChangesetFile(readFileSync(join(dir, file), 'utf8')));
const problems: string[] = [];
const flagged = new Set<string>();
for (const [index, changeset] of changesets.entries()) {
  const file = files[index];
  if (file === undefined) continue;
  for (const { name, type } of disallowedBumps(changeset, versions)) {
    flagged.add(name);
    const needs = type === 'major' ? RELEASE : `${BREAKING} or ${RELEASE}`;
    problems.push(`.changeset/${file}: ${type} bump of ${name} ${versions.get(name)}; on 0.x a feature or fix is a patch, and a ${type} needs a summary opening with ${needs}`);
  }
}

const changesByPackage = new Map<string, { type: 'patch' | 'minor' | 'major'; summary: string }[]>();
for (const changeset of changesets) {
  for (const { name, type } of changeset.releases) {
    if (type !== 'patch' && type !== 'minor' && type !== 'major') continue;
    const list = changesByPackage.get(name) ?? [];
    list.push({ type, summary: changeset.summary });
    changesByPackage.set(name, list);
  }
}

const packages = publicPackages();
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const inputs: FloorRaiseInput[] = [];
let skipped = 0;
for (const { path, manifest } of packages) {
  if (manifest.version === undefined) continue;
  const tagManifest = showAtTag(`${manifest.name}@${manifest.version}`, relative(REPO_ROOT, path));
  if (tagManifest === undefined) {
    skipped += 1;
    continue;
  }
  let previous: Partial<PackageManifest>;
  try {
    previous = JSON.parse(tagManifest) as Partial<PackageManifest>;
  } catch {
    skipped += 1;
    continue;
  }
  for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
    if (!isWidePeerRange(range)) continue;
    const currentFloor = peerFloor(range);
    const previousRange = previous.peerDependencies?.[peer];
    const previousFloor = previousRange === undefined ? undefined : peerFloor(previousRange);
    if (currentFloor === undefined || previousFloor === undefined || currentFloor === previousFloor) continue;
    const sibling = byName.get(peer);
    if (sibling === undefined) continue;
    let changelog: string | undefined;
    try {
      changelog = readFileSync(join(dirname(sibling.path), 'CHANGELOG.md'), 'utf8');
    } catch {
      changelog = undefined;
    }
    if (changelog === undefined) {
      skipped += 1;
      continue;
    }
    inputs.push({
      name: manifest.name,
      path: relative(REPO_ROOT, path),
      peer,
      previousFloor,
      currentFloor,
      released: releasedVersions(changelog),
      changes: changesByPackage.get(manifest.name) ?? [],
      alreadyFlagged: flagged.has(manifest.name),
    });
  }
}
problems.push(...floorRaiseProblems(inputs));

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `changeset bumps: ${files.length} pending, none an unannounced 0.x minor or major; ${inputs.length} peer floor ${inputs.length === 1 ? 'change' : 'changes'} checked against their releases, none raised past an accepted minor without a **Breaking:** minor${skipped > 0 ? ` (${skipped} skipped: no release tag or changelog)` : ''}\n`,
  );
}
