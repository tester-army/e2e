/**
 * Puts every public package's peer on another public package back to the
 * wide range main keeps.
 *
 * `changeset version --snapshot canary` pins those peers to the siblings'
 * exact canary versions: a prerelease satisfies no `>=x <1` range, so
 * changesets treats the sibling as out of range and rewrites the peer. The
 * published tarballs need the pin (`init` installs the matching runner
 * canary); the `chore: release` commit must not keep it, or every later
 * release of the sibling cascades a patch to each dependent and a consumer who
 * updates the sibling alone hits an unmet peer. A pin becomes
 * `>=<major.minor.patch> <major+1>` of the sibling as versioned, the
 * prerelease suffix dropped. A peer already in that shape keeps its floor: an
 * engine a runner minor left alone still names the runner it was built
 * against.
 *
 * Usage: `node scripts/restore-peer-ranges.ts`, after `changeset publish` and
 * before the commit; `pnpm run canary:publish` runs it. `check-peer-ranges.ts`
 * in `pnpm check` fails on anything but this shape.
 */

import { writeFileSync } from 'node:fs';
import { isWidePeerRange, publicPackages, siblingPeers, widePeerRange } from './public-packages.ts';

const packages = publicPackages();
const versions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
const siblings = new Set(versions.keys());

let restored = 0;
for (const { path, manifest } of packages) {
  const peers = manifest.peerDependencies;
  const pinned = siblingPeers(peers, siblings).filter(([, range]) => !isWidePeerRange(range));
  if (peers === undefined || pinned.length === 0) continue;
  for (const [peer, current] of pinned) {
    const version = versions.get(peer);
    if (version === undefined) {
      console.error(`${peer} has no version to restore the peer of ${manifest.name} from`);
      process.exit(1);
    }
    peers[peer] = widePeerRange(version);
    console.log(`${manifest.name}: ${peer} peer ${current} -> ${peers[peer]}`);
    restored += 1;
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
if (restored === 0) console.log('every peer on a sibling package already reads a wide range');
