/**
 * Fails when a public package's peer on another public package (an engine's
 * on `e2e`, an integration's on an engine) is anything but
 * `>=<major.minor.patch> <major+1>`, or names a version the sibling never
 * released (no `## <version>` in its CHANGELOG.md, and no pending changeset
 * releasing it), or imports an `e2e/*` export the floor version does not
 * have (#1657 rule (c): a new `e2e/engine` import counts as raising the
 * floor).
 *
 * `changeset version --snapshot canary` rewrites those peers to the siblings'
 * exact canary versions, and the canary output is committed to main as
 * `chore: release`. An exact pin that lands makes changesets patch-bump the
 * dependent and rewrite the pin on each release of the sibling, and leaves a
 * consumer who updates the sibling alone with a peer npm 7+ refuses
 * (ERESOLVE). `restore-peer-ranges.ts` puts the ranges back after a publish;
 * this check is what notices when it did not run. `peer-ranges.ts` says why
 * the floor must also be a released version; `engine-exports.ts` says how
 * the floor version's exports are read (the `e2e@<version>` tag).
 *
 * Usage: `node scripts/check-peer-ranges.ts`, part of `pnpm check`. Exits 1
 * listing every offending peer.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseChangesetFile } from '@changesets/parse';
import { nextVersionAfterBump, pendingBumps } from './changeset-bumps.ts';
import { engineImportProblems, engineImports, tagExportsAt, type EngineImportCheck } from './engine-exports.ts';
import { peerFloor, peerRangeProblems } from './peer-ranges.ts';
import { REPO_ROOT, publicPackages, siblingPeers } from './public-packages.ts';

/** Reads `path` at `tag` (`git show`), undefined when the tag or the file does not exist. */
function showAtTag(tag: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${tag}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** The TypeScript files under `dirPath`, recursively; unreadable entries are skipped. */
function sourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) out.push(full);
      } catch {
        continue;
      }
    }
  };
  walk(dirPath);
  return out;
}

const packages = publicPackages();
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const checked: string[] = [];
for (const { manifest } of packages) {
  for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
    checked.push(`${manifest.name} on ${peer} (${range})`);
  }
}

// The version each sibling's pending changesets will release: a floor may
// name it as the runner version in the same release.
const dir = join(REPO_ROOT, '.changeset');
const changesetFiles = readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md');
const changesets = changesetFiles.map((file) => parseChangesetFile(readFileSync(join(dir, file), 'utf8')));
const versions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
const nextVersions = new Map<string, string>();
for (const [name, bump] of pendingBumps(changesets)) {
  const version = versions.get(name);
  if (version === undefined) continue;
  const next = nextVersionAfterBump(version, bump);
  if (next !== undefined) nextVersions.set(name, next);
}

const problems = peerRangeProblems(packages, (packagePath) => {
  try {
    return readFileSync(join(dirname(packagePath), 'CHANGELOG.md'), 'utf8');
  } catch {
    return undefined;
  }
}, nextVersions);

// Rule (c): every named import from `e2e/*` must be exported by `e2e` at
// the package's peer floor, read off the `e2e@<floor>` tag.
const siblingDirs = new Map(packages.map(({ manifest, path }) => [manifest.name, relative(REPO_ROOT, dirname(path))]));
const exportsCache = new Map<string, ReadonlySet<string> | undefined>();
const exportsAt = (sibling: string, subpath: string, version: string): ReadonlySet<string> | undefined => {
  const key = `${sibling}@${version}:${subpath}`;
  if (exportsCache.has(key)) return exportsCache.get(key);
  const siblingDir = siblingDirs.get(sibling);
  const resolved = siblingDir === undefined ? undefined : tagExportsAt(showAtTag, `${sibling}@${version}`, siblingDir, subpath);
  exportsCache.set(key, resolved);
  return resolved;
};

const checks: EngineImportCheck[] = [];
for (const { path, manifest } of packages) {
  const range = manifest.peerDependencies?.['e2e'];
  if (range === undefined) continue;
  const floor = peerFloor(range);
  if (floor === undefined) continue;
  const imports = new Map<string, Set<string>>();
  for (const file of sourceFiles(join(dirname(path), 'src'))) {
    for (const [subpath, names] of engineImports(readFileSync(file, 'utf8'))) {
      let set = imports.get(subpath);
      if (set === undefined) {
        set = new Set<string>();
        imports.set(subpath, set);
      }
      for (const name of names) set.add(name);
    }
  }
  if (imports.size === 0) continue;
  checks.push({ packageName: manifest.name, packagePath: relative(REPO_ROOT, path), sibling: 'e2e', floor, imports });
}
const { problems: importProblems, unverifiable } = engineImportProblems(checks, exportsAt);
problems.push(...importProblems);

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} as wide ranges on released versions; ${checks.length} packages' e2e imports verified against their floors\n`);
}
for (const note of unverifiable) {
  process.stdout.write(`note: ${note}\n`);
}
