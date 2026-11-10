/**
 * Fails when a pending changeset bumps a `0.x` package by `minor` without a
 * summary opening `**Breaking:**` or `**Release:**`, or by `major` without
 * `**Release:**` (`changeset-bumps.ts` says why), or when a changeset
 * raises a package's peer floor on a sibling past a runner minor the
 * previous range accepted without a `**Breaking:**` minor
 * (`floorRaiseProblems` in `changeset-bumps.ts` says how a raise is judged).
 * The previous floor is the one at the package's release tag; on a
 * generated release PR the current version has no tag yet, so the previous
 * released tag is used instead, and the version bump from that tag counts
 * as the announcement when it is a `0.x` minor or a major.
 *
 * Usage: `node scripts/check-changeset-bumps.ts`, part of `pnpm check`. Exits
 * 1 listing every offending changeset.
 */

import { relative } from 'node:path';
import { listTags, pendingChangesets, readChangelog, showAtTag } from './check-helpers.ts';
import { BREAKING, RELEASE, disallowedBumps, floorRaiseProblems, latestReleaseVersion, versionBumpAnnounces, type BumpType, type FloorRaiseInput } from './changeset-bumps.ts';
import { peerFloor, releasedVersions } from './peer-ranges.ts';
import { REPO_ROOT, isWidePeerRange, publicPackages, siblingPeers, type PackageManifest } from './public-packages.ts';

/** The manifest at the package's latest released tag, undefined when it has no release tag. A generated release PR has already bumped the version, so the tag for the current version does not exist yet; the previous released manifest is the one to compare the floor against, instead of skipping the check. */
function previousReleaseManifest(name: string, packagePath: string): string | undefined {
  const latest = latestReleaseVersion(listTags(`${name}@*`), name);
  if (latest === undefined) return undefined;
  return showAtTag(`${name}@${latest}`, packagePath);
}

const versions = new Map(publicPackages().flatMap(({ manifest }) => (manifest.version === undefined ? [] : [[manifest.name, manifest.version] as const])));
const pending = pendingChangesets();
const problems: string[] = [];
const flagged = new Set<string>();
for (const { file, changeset } of pending) {
  for (const { name, type } of disallowedBumps(changeset, versions)) {
    flagged.add(name);
    const needs = type === 'major' ? RELEASE : `${BREAKING} or ${RELEASE}`;
    problems.push(`.changeset/${file}: ${type} bump of ${name} ${versions.get(name)}; on 0.x a feature or fix is a patch, and a ${type} needs a summary opening with ${needs}`);
  }
}

const changesByPackage = new Map<string, { type: BumpType; summary: string }[]>();
for (const { changeset } of pending) {
  for (const { name, type } of changeset.releases) {
    if (type !== 'patch' && type !== 'minor' && type !== 'major') continue;
    const list = changesByPackage.get(name) ?? [];
    list.push({ type, summary: changeset.summary });
    changesByPackage.set(name, list);
  }
}

// With no `e2e@*` tags at all there is no released version to compare a
// floor against, so the rule below would quietly skip every package.
// Fail loudly instead: a tagless checkout must fetch the tags.
if (listTags('e2e@*').length === 0) {
  problems.push('no e2e@* tags exist; a peer floor cannot be compared against any released version, so the check fails instead of quietly skipping (fetch the tags: git fetch --tags)');
}

const packages = publicPackages();
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const inputs: FloorRaiseInput[] = [];
let skipped = 0;
for (const { path, manifest } of packages) {
  if (manifest.version === undefined) continue;
  let tagManifest = showAtTag(`${manifest.name}@${manifest.version}`, relative(REPO_ROOT, path));
  const fellBack = tagManifest === undefined;
  if (fellBack) tagManifest = previousReleaseManifest(manifest.name, relative(REPO_ROOT, path));
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
    const changelog = readChangelog(sibling.path);
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
      announcedByVersionBump: fellBack && previous.version !== undefined && versionBumpAnnounces(previous.version, manifest.version),
    });
  }
}
problems.push(...floorRaiseProblems(inputs));

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `changeset bumps: ${pending.length} pending, none an unannounced 0.x minor or major; ${inputs.length} peer floor ${inputs.length === 1 ? 'change' : 'changes'} checked against their releases, none raised past an accepted minor without a **Breaking:** minor${skipped > 0 ? ` (${skipped} skipped: no release tag or changelog)` : ''}\n`,
  );
}
