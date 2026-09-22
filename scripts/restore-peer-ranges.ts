/**
 * Puts every public package's `e2e` peer back to the wide range main keeps.
 *
 * `changeset version --snapshot canary` pins that peer to the runner's exact
 * canary version: a prerelease satisfies no `>=x <1` range, so changesets
 * treats the runner as out of range and rewrites the peer. The published
 * tarballs need the pin (`init` installs the matching runner canary); the
 * `chore: release` commit must not keep it, or every later runner release
 * cascades a patch to each engine and a consumer who updates `e2e` alone
 * hits an unmet peer. A pin becomes `>=<major.minor.patch> <major+1>` of the
 * runner as versioned, the prerelease suffix dropped. A peer already in that
 * shape keeps its floor: an engine a runner minor left alone still names the
 * runner it was built against.
 *
 * Usage: `node scripts/restore-peer-ranges.ts`, after `changeset publish` and
 * before the commit; `pnpm run canary:publish` runs it. `check-peer-ranges.ts`
 * in `pnpm check` fails on anything but this shape.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, RUNNER, isRunnerPeerRange, publicPackages, runnerPeerRange, type PackageManifest } from './public-packages.ts';

const runner = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', RUNNER, 'package.json'), 'utf8')) as PackageManifest;
if (runner.version === undefined) {
  console.error(`packages/${RUNNER}/package.json has no version`);
  process.exit(1);
}
const range = runnerPeerRange(runner.version);

let restored = 0;
for (const { path, manifest } of publicPackages()) {
  const peers = manifest.peerDependencies;
  const current = peers?.[RUNNER];
  if (peers === undefined || current === undefined || isRunnerPeerRange(current)) continue;
  peers[RUNNER] = range;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name}: ${RUNNER} peer ${current} -> ${range}`);
  restored += 1;
}
if (restored === 0) console.log(`every ${RUNNER} peer already reads a wide range`);
