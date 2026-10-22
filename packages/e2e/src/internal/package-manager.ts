/** Which package manager a project uses, for install hints that name a runnable command. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, matchesGlob } from './globs.ts';
import { isPlainObject } from './options.ts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun']);
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

function isPackageManager(value: string | undefined): value is PackageManager {
  return value !== undefined && PACKAGE_MANAGERS.has(value);
}

/** The manager a `packageManager` field such as `pnpm@10.0.0` names, or undefined for another value. */
function fieldManager(packageManagerField: string | undefined): PackageManager | undefined {
  const configured = packageManagerField?.split('@')[0];
  return isPackageManager(configured) ? configured : undefined;
}

/** The manager whose lockfile sits in `dir`, or undefined when none does. */
function lockfileManager(dir: string): PackageManager | undefined {
  return LOCKFILES.find(([lock]) => existsSync(path.join(dir, lock)))?.[1];
}

/**
 * The `packageManager` field wins, then a lockfile in `dir`, then the manager
 * that invoked the current process, then npm.
 */
export function detectPackageManager(
  dir: string,
  packageManagerField?: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const found = fieldManager(packageManagerField) ?? lockfileManager(dir);
  if (found !== undefined) return found;
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/**
 * The manager of the package in `dir`, which may be a member of a workspace
 * whose lockfile and `packageManager` field are at the workspace root: the
 * package's own field or lockfile (or pnpm, for a pnpm workspace root that
 * has neither yet), else those of the nearest workspace root
 * above whose package globs include it, else the manager that invoked the
 * current process, else npm. A lockfile above that belongs to no workspace
 * holding the package is another project's, and does not count. `root` is
 * where the install keeps its lockfile: the workspace root for a member, the
 * package's own directory otherwise.
 */
export function detectWorkspacePackageManager(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly manager: PackageManager; readonly root: string } {
  const project = path.resolve(dir);
  const own = managerAt(project) ?? workspaceGlobs(project)?.manager;
  if (own !== undefined) return { manager: own, root: project };
  for (let current = path.dirname(project); ; current = path.dirname(current)) {
    const workspace = workspaceGlobs(current);
    if (workspace !== undefined) {
      const member = includesPackage(workspace.globs, path.relative(current, project).split(path.sep).join('/'));
      if (member) return { manager: managerAt(current) ?? workspace.manager ?? invokingManager(env), root: current };
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return { manager: invokingManager(env), root: project };
}

/** The lockfile names every manager writes, for a caller that must put one back. */
export const LOCKFILE_NAMES: readonly string[] = [...new Set(LOCKFILES.map(([lock]) => lock))];

function invokingManager(env: NodeJS.ProcessEnv): PackageManager {
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/** The manager `dir` names itself: its `packageManager` field, else its lockfile. */
function managerAt(dir: string): PackageManager | undefined {
  const field = readPackageManifest(dir)?.['packageManager'];
  return fieldManager(typeof field === 'string' ? field : undefined) ?? lockfileManager(dir);
}

/** The package.json in `dir` as an object, or undefined when it is missing or not one. */
export function readPackageManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return isPlainObject(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package globs of a workspace root at `dir`: `pnpm-workspace.yaml`'s
 * `packages` list (a pnpm workspace), else the `workspaces` field of its
 * package.json, an array or `{ packages }` (npm, Yarn, Bun). Undefined when
 * `dir` is no workspace root.
 */
function workspaceGlobs(dir: string): { globs: string[]; manager: PackageManager | undefined } | undefined {
  try {
    return { globs: pnpmWorkspacePackages(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')), manager: 'pnpm' };
  } catch {
    // No pnpm workspace here; the manifest may declare one.
  }
  const field = readPackageManifest(dir)?.['workspaces'];
  const list = Array.isArray(field) ? field : typeof field === 'object' && field !== null && 'packages' in field ? field.packages : undefined;
  if (!Array.isArray(list)) return undefined;
  return { globs: list.filter((glob): glob is string => typeof glob === 'string'), manager: undefined };
}

/**
 * The entries of the top-level `packages:` list in a pnpm-workspace.yaml,
 * without reading the rest of the YAML: a block list, indented or not, or a
 * flow list on one line or several (`packages: ['apps/*']`).
 */
function pnpmWorkspacePackages(text: string): string[] {
  const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
  const flow = /^packages:[ \t]*\[([^\]]*)\]/mu.exec(text.replace(/[ \t]+#.*$/gmu, ''));
  if (flow !== null) return flow[1]!.split(',').map(unquote).filter((glob) => glob !== '');
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^packages:\s*(?:#.*)?$/u.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*(?:#.*)?$/u.test(line)) continue;
    const item = /^\s*-\s+(.+?)\s*(?:#.*)?$/u.exec(line);
    if (item === null) break;
    globs.push(unquote(item[1]!));
  }
  return globs;
}

/** Whether `relative`, a `/`-separated path from the workspace root, matches an including glob and no `!` one. */
function includesPackage(globs: readonly string[], relative: string): boolean {
  if (relative === '' || relative.startsWith('..')) return false;
  const matches = (pattern: string): boolean => {
    const normalized = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (normalized === relative) return true;
    try {
      return matchesGlob(compileGlob(normalized), relative);
    } catch {
      return false;
    }
  };
  return (
    globs.some((glob) => !glob.startsWith('!') && matches(glob)) &&
    !globs.some((glob) => glob.startsWith('!') && matches(glob.slice(1)))
  );
}

/** The command that runs the package.json script `name` with the given manager. */
export function runScriptCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm run ${name}`;
    case 'pnpm':
      return `pnpm ${name}`;
    case 'yarn':
      return `yarn ${name}`;
    case 'bun':
      return `bun run ${name}`;
  }
}

/** The command that runs an installed binary, never a registry download, with the given manager. */
export function execCommand(manager: PackageManager, command: string): string {
  switch (manager) {
    case 'npm':
      return `npm exec -- ${command}`;
    case 'pnpm':
      return `pnpm exec ${command}`;
    case 'yarn':
      return `yarn ${command}`;
    case 'bun':
      return `bun run ${command}`;
  }
}

/** The command that adds `name` as a dev dependency with the given manager. */
export function addDevDependencyCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm install --save-dev ${name}`;
    case 'pnpm':
      return `pnpm add -D ${name}`;
    case 'yarn':
      return `yarn add -D ${name}`;
    case 'bun':
      return `bun add -d ${name}`;
  }
}
