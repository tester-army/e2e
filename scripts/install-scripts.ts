/**
 * Finds the packages a consumer's install would run a script for, in the
 * dependency tree of a package as installed on this machine.
 *
 * pnpm 11 and later fail an install on any dependency build script the
 * project has not decided on (`ERR_PNPM_IGNORED_BUILDS`), so one such
 * package anywhere under a published package breaks `pnpm install` for every
 * new user. npm runs a package's `preinstall`, `install`, and `postinstall`,
 * and `node-gyp rebuild` for a `binding.gyp` with no install script of its
 * own; any of them counts.
 *
 * The walk follows `dependencies`, `optionalDependencies`, and the
 * `peerDependencies` an install adds unasked (npm 7 and later, pnpm), the way
 * Node.js resolves them from each package's real path. An optional
 * dependency this platform skipped (another OS's native binary) is not
 * there to read.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

interface Manifest {
  name: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface InstallScript {
  /** `root > dependency > ... > package@version`. */
  readonly chain: string;
  /** What an install would run: the scripts, or `node-gyp rebuild`. */
  readonly runs: string;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** The real directory of `name` as Node.js resolves it from `fromDir`, or undefined when it is not installed. */
function locate(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** What installing the package in `dir` runs, or undefined when nothing. */
function installRuns(dir: string, manifest: Manifest): string | undefined {
  const hooks = INSTALL_HOOKS.filter((hook) => manifest.scripts?.[hook] !== undefined);
  if (hooks.length > 0) return hooks.map((hook) => `${hook}: ${manifest.scripts![hook]}`).join('; ');
  return existsSync(join(dir, 'binding.gyp')) ? 'node-gyp rebuild (binding.gyp)' : undefined;
}

/** The dependencies an install of `manifest` brings in, each with whether it may be absent. */
function installedDependencies(manifest: Manifest): [name: string, optional: boolean][] {
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true);
  return [
    ...Object.keys(manifest.dependencies ?? {}).map((name): [string, boolean] => [name, false]),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name): [string, boolean] => [name, true]),
    ...peers.map((name): [string, boolean] => [name, false]),
  ];
}

/**
 * Every package in the installed dependency tree of the package in
 * `packageDir` (not the package itself) whose install runs a script. Throws
 * when a required dependency is not installed: the tree cannot be read.
 */
export function findInstallScripts(packageDir: string): InstallScript[] {
  const root = readManifest(packageDir);
  const found: InstallScript[] = [];
  const seen = new Set<string>([realpathSync(packageDir)]);
  const queue: { dir: string; manifest: Manifest; chain: string }[] = [{ dir: realpathSync(packageDir), manifest: root, chain: root.name }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const [name, optional] of installedDependencies(next.manifest)) {
      const dir = locate(name, next.dir);
      if (dir === undefined) {
        if (optional) continue;
        throw new Error(`${next.chain} > ${name} is not installed; run pnpm install`);
      }
      if (seen.has(dir)) continue;
      seen.add(dir);
      const manifest = readManifest(dir);
      const chain = `${next.chain} > ${manifest.name}@${manifest.version ?? '?'}`;
      const runs = installRuns(dir, manifest);
      if (runs !== undefined) found.push({ chain, runs });
      queue.push({ dir, manifest, chain });
    }
  }
  return found;
}
