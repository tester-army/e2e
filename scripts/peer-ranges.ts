/**
 * The peer-range policy for one public package's peer on another public
 * package (an engine's on `e2e`, an integration's on an engine).
 *
 * Two rules. First, the shape: `>=<major.minor.patch> <major+1>`, the floor
 * the oldest sibling the package works with. Anything narrower puts every
 * sibling minor out of range, and changesets then patch-bumps the dependent
 * and rewrites its pin on every release of the sibling; an exact pin also
 * leaves a consumer who updates the sibling alone with a peer npm 7+
 * refuses. Second, the floor must name a version the sibling actually
 * released, read off its CHANGELOG.md (`## x.y.z` headings), or the version
 * the sibling's pending changesets will release alongside it (the
 * sibling's version in the same release). A floor past the latest stable names a
 * version no install can satisfy: #1657 raised both engines to `>=0.22.1`
 * in a patch release, but no stable `e2e@0.22.1` ever shipped (only
 * nightlies), so a fresh `npm install` of an unchanged project on
 * `e2e ~0.21.3` failed with ERESOLVE. The same shape hid in `@e2e-dev/acp`
 * (`>=0.21.4`, never released) and `@e2e-dev/limrun`
 * (`@e2e-dev/mobile >=0.11.1`, never released). A floor may rise only once
 * its version is in the changelog (or is the sibling's pending release);
 * until then the package either works without the new export, on the old
 * floor, or waits for the release.
 */

import { relative } from 'node:path';
import { REPO_ROOT, isWidePeerRange, type PackageManifest } from './public-packages.ts';

export interface PublicPackage {
  readonly path: string;
  readonly manifest: PackageManifest;
}

/** The floor of a wide peer range: `0.15.0` of `>=0.15.0 <1`; undefined for any other shape. */
export function peerFloor(range: string): string | undefined {
  const match = /^>=(\d+\.\d+\.\d+) <\d+$/.exec(range);
  return match === null ? undefined : match[1];
}

/** The versions a changelog records as released, from its `## x.y.z` headings. */
export function releasedVersions(changelog: string): ReadonlySet<string> {
  const versions: string[] = [];
  for (const match of changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)) {
    if (match[1] !== undefined) versions.push(match[1]);
  }
  return new Set(versions);
}

/**
 * Every sibling peer range in `packages` that breaks the policy, one
 * human-readable problem per offending peer. `readChangelog` reads the
 * sibling's CHANGELOG.md for a package path (undefined when it has none);
 * the check script passes the real read, tests pass a fake. `nextVersions`
 * maps a sibling to the version its pending changesets will release, which
 * a floor may name as the sibling's version in the same release.
 */
export function peerRangeProblems(
  packages: readonly PublicPackage[],
  readChangelog: (packagePath: string) => string | undefined,
  nextVersions: ReadonlyMap<string, string> = new Map(),
): string[] {
  const siblings = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const problems: string[] = [];
  for (const { path, manifest } of packages) {
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => siblings.has(name))) {
      const display = relative(REPO_ROOT, path);
      if (!isWidePeerRange(range)) {
        problems.push(
          `${display}: ${peer} peer is ${JSON.stringify(range)}, expected >=<major.minor.patch> <major+1>; run \`node scripts/restore-peer-ranges.ts\``,
        );
        continue;
      }
      const floor = peerFloor(range);
      const sibling = siblings.get(peer);
      if (floor === undefined || sibling === undefined) continue;
      const changelog = readChangelog(sibling.path);
      if (changelog === undefined) {
        if (nextVersions.get(peer) !== floor) {
          problems.push(
            `${display}: ${peer} peer floor is ${floor}, but ${peer} has no CHANGELOG.md to show it released; a floor must name a released stable version`,
          );
        }
      } else if (!releasedVersions(changelog).has(floor) && nextVersions.get(peer) !== floor) {
        problems.push(
          `${display}: ${peer} peer floor is ${floor}, which ${peer} never released (no ## ${floor} in its CHANGELOG.md) and no pending changeset releases; a floor must name a released stable version, or the sibling's version in the same release, so a patch release cannot raise it past the latest stable. Raise it only after that version ships, or keep the old floor when the package works without the new export`,
        );
      }
    }
  }
  return problems;
}
