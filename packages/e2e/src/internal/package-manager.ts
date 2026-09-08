/** Which package manager a project uses, for install hints that name a runnable command. */

import { existsSync } from 'node:fs';
import path from 'node:path';

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

/**
 * The `packageManager` field wins, then a lockfile in `dir`, then the manager
 * that invoked the current process, then npm.
 */
export function detectPackageManager(
  dir: string,
  packageManagerField?: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const configured = packageManagerField?.split('@')[0];
  if (isPackageManager(configured)) return configured;
  for (const [lock, manager] of LOCKFILES) {
    if (existsSync(path.join(dir, lock))) return manager;
  }
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
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
