/**
 * Fails when a public package's peer on another public package (an engine's
 * on `e2e`, an integration's on an engine) is anything but
 * `>=<major.minor.patch> <major+1>`, or names a version the sibling never
 * released (no `## <version>` in its CHANGELOG.md, and no pending changeset
 * releasing it), or imports an `e2e/*` export the floor version does not
 * have (rule (c): a new `e2e/engine` import counts as raising the floor).
 *
 * A floor naming the version the sibling's pending changesets will release
 * has no tag yet, so its imports are verified against the working tree,
 * which is that pending release's source, instead of passing on an
 * unverifiable note.
 *
 * `changeset version --snapshot canary` rewrites those peers to the siblings'
 * exact canary versions; `restore-peer-ranges.ts` puts the ranges back after
 * a publish, and this check is what notices when it did not run. See
 * `peer-ranges.ts` for why the floor must be a released version and
 * `engine-exports.ts` for how the floor version's exports are read.
 *
 * Usage: `node scripts/check-peer-ranges.ts`, part of `pnpm check`. Exits 1
 * listing every offending peer.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { collectEngineImports, listTags, pendingChangesets, readChangelog, showAtTag } from './check-helpers.ts';
import { nextVersionAfterBump, pendingBumps } from './changeset-bumps.ts';
import { engineImportProblems, tagExportsAt, type EngineImportCheck, type ExportSets } from './engine-exports.ts';
import { peerFloor, peerRangeProblems } from './peer-ranges.ts';
import { REPO_ROOT, publicPackages, siblingPeers } from './public-packages.ts';

const packages = publicPackages();
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const checked: string[] = [];
for (const { manifest } of packages) {
  for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
    checked.push(`${manifest.name} on ${peer} (${range})`);
  }
}

// The version each sibling's pending changesets will release: a floor may
// name it as the sibling's version in the same release.
const { changesets } = pendingChangesets();
const versions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
const nextVersions = new Map<string, string>();
for (const [name, bump] of pendingBumps(changesets)) {
  const version = versions.get(name);
  if (version === undefined) continue;
  const next = nextVersionAfterBump(version, bump);
  if (next !== undefined) nextVersions.set(name, next);
}

const problems = peerRangeProblems(packages, readChangelog, nextVersions);

// With no `e2e@*` tags at all there is no tag record to verify any import
// against, so rule (c) would quietly pass every package. Fail loudly
// instead: a tagless checkout must fetch the tags.
if (listTags('e2e@*').length === 0) {
  problems.push('no e2e@* tags exist; no e2e import can be verified against its floor version, so the check fails instead of quietly passing (fetch the tags: git fetch --tags)');
}

// Rule (c): every named import from `e2e/*` must be exported by `e2e` at
// the package's peer floor, read off the `e2e@<floor>` tag.
const siblingDirs = new Map(packages.map(({ manifest, path }) => [manifest.name, relative(REPO_ROOT, dirname(path))]));
const exportsCache = new Map<string, ExportSets | undefined>();

/** Reads `path` from the working tree, undefined when it cannot be read. */
function showWorkingTree(_tag: string, path: string): string | undefined {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return undefined;
  }
}

const exportsAt = (sibling: string, subpath: string, version: string): ExportSets | undefined => {
  const key = `${sibling}@${version}:${subpath}`;
  if (exportsCache.has(key)) return exportsCache.get(key);
  const siblingDir = siblingDirs.get(sibling);
  let resolved = siblingDir === undefined ? undefined : tagExportsAt(showAtTag, `${sibling}@${version}`, siblingDir, subpath);
  if (resolved === undefined && siblingDir !== undefined && nextVersions.get(sibling) === version) {
    // A floor naming the version the sibling's pending changesets will
    // release has no tag yet, so the tag lookup cannot verify it; the
    // working tree is that pending release's source, so verify against it
    // instead of passing the floor on an unverifiable note.
    resolved = tagExportsAt(showWorkingTree, `${sibling}@${version}`, siblingDir, subpath);
  }
  exportsCache.set(key, resolved);
  return resolved;
};

const checks: EngineImportCheck[] = [];
for (const { path, manifest } of packages) {
  const range = manifest.peerDependencies?.['e2e'];
  if (range === undefined) continue;
  const floor = peerFloor(range);
  if (floor === undefined) continue;
  const imports = collectEngineImports(path);
  if (imports.size === 0) continue;
  checks.push({ packageName: manifest.name, packagePath: relative(REPO_ROOT, path), sibling: 'e2e', floor, imports });
}
const { problems: importProblems, unverifiable, verified } = engineImportProblems(checks, exportsAt);
problems.push(...importProblems);

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} as wide ranges on released versions; ${verified} packages' e2e imports verified against their floors\n`);
}
for (const note of unverifiable) {
  process.stdout.write(`note: ${note}\n`);
}
