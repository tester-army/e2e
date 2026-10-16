/**
 * What the release scripts agree on: which packages under `packages/` publish,
 * and the shape of the peer range one keeps on another.
 *
 * An engine or reporter peers on `e2e`, and an integration on the engine it
 * plugs into, as `>=<major.minor.patch> <major+1>`, the floor the oldest
 * sibling it works with. Anything narrower puts every
 * sibling minor out of range, and changesets then patch-bumps the dependent
 * and rewrites its pin on every release of the sibling; an exact pin also
 * leaves a consumer who updates the sibling alone with a peer npm 7+ refuses.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface PackageManifest {
  name: string;
  version?: string;
  private?: boolean;
  peerDependencies?: Record<string, string>;
}

const WIDE_RANGE = /^>=(\d+)\.\d+\.\d+ <(\d+)$/;

/** Every publishable package under `packages/`: a named manifest without `private: true`. */
export function publicPackages(): { path: string; manifest: PackageManifest }[] {
  const packages: { path: string; manifest: PackageManifest }[] = [];
  for (const dir of readdirSync(join(REPO_ROOT, 'packages'))) {
    const path = join(REPO_ROOT, 'packages', dir, 'package.json');
    let manifest: Partial<PackageManifest>;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageManifest>;
    } catch {
      continue;
    }
    if (manifest.private === true || manifest.name === undefined) continue;
    packages.push({ path, manifest: manifest as PackageManifest });
  }
  return packages;
}

/** The peer range on a sibling at `version`, its prerelease suffix dropped: `>=0.15.0 <1` for `0.15.0-canary-x`. */
export function widePeerRange(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`version ${JSON.stringify(version)} is not semver`);
  const [, major, minor, patch] = match;
  return `>=${major}.${minor}.${patch} <${Number(major) + 1}`;
}

/** Whether `range` has the shape `widePeerRange` produces, whatever its floor. */
export function isWidePeerRange(range: string): boolean {
  const match = WIDE_RANGE.exec(range);
  return match !== null && Number(match[2]) === Number(match[1]) + 1;
}

/** The peers in `peers` that name another public package, with the range each declares. */
export function siblingPeers(peers: Readonly<Record<string, string>> | undefined, siblings: ReadonlySet<string>): [name: string, range: string][] {
  return Object.entries(peers ?? {}).filter(([name]) => siblings.has(name));
}
