/**
 * What the release scripts agree on: which packages under `packages/` publish,
 * and the shape of the peer range they keep on the runner.
 *
 * An engine or reporter peers on `e2e` as `>=<major.minor.patch> <major+1>`
 * of the runner it was built against (`>=0.15.0 <1` today). Anything narrower
 * puts every runner minor out of range, and changesets then patch-bumps the
 * dependent and rewrites its pin on every runner release; an exact pin also
 * leaves a consumer who updates `e2e` alone with a peer npm 7+ refuses.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The runner package every engine and reporter peers on. */
export const RUNNER = 'e2e';

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

/** The peer range on a runner at `version`, its prerelease suffix dropped: `>=0.15.0 <1` for `0.15.0-canary-x`. */
export function runnerPeerRange(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`runner version ${JSON.stringify(version)} is not semver`);
  const [, major, minor, patch] = match;
  return `>=${major}.${minor}.${patch} <${Number(major) + 1}`;
}

/** Whether `range` has the shape `runnerPeerRange` produces, whatever its floor. */
export function isRunnerPeerRange(range: string): boolean {
  const match = WIDE_RANGE.exec(range);
  return match !== null && Number(match[2]) === Number(match[1]) + 1;
}
