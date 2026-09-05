/** package.json reading, dependency additions, and package-manager detection for `e2e init`. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const dependencyBlock = z.record(z.string(), z.string()).optional();
const packageSchema = z.looseObject({
  dependencies: dependencyBlock,
  devDependencies: dependencyBlock,
  peerDependencies: dependencyBlock,
  optionalDependencies: dependencyBlock,
  packageManager: z.string().optional(),
});
type PackageManifest = z.infer<typeof packageSchema>;

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

/**
 * Reads and validates the manifest, keeping its original text so edits can
 * preserve formatting. A missing manifest starts as a private ESM package.
 */
export function readPackage(cwd: string) {
  const manifestPath = path.join(cwd, 'package.json');
  const original = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined;
  const manifest = packageSchema.parse(original === undefined ? { private: true, type: 'module' } : JSON.parse(original));
  return { original, manifest };
}

/** True when any dependency section lists `name`, so existing versions and workspace links are kept. */
function declaresDependency(manifest: PackageManifest, name: string): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
    .some((block) => block?.[name] !== undefined);
}

/** Adds only missing dependencies to devDependencies and returns what was added. */
export function addDependencies(manifest: PackageManifest, dependencies: Readonly<Record<string, string>>) {
  const additions = Object.entries(dependencies).filter(([name]) => !declaresDependency(manifest, name));
  if (additions.length === 0) return { manifest, additions };
  return {
    manifest: { ...manifest, devDependencies: { ...manifest.devDependencies, ...Object.fromEntries(additions) } },
    additions,
  };
}

/** The `packageManager` field wins, then a lockfile, then the manager that invoked the CLI, then npm. */
export function detectPackageManager(cwd: string, manifest: PackageManifest): string {
  const configured = manifest.packageManager?.split('@')[0];
  if (configured !== undefined && PACKAGE_MANAGERS.has(configured)) return configured;
  for (const [lock, manager] of LOCKFILES) {
    if (existsSync(path.join(cwd, lock))) return manager;
  }
  const invoking = process.env['npm_config_user_agent']?.split('/')[0];
  return invoking !== undefined && PACKAGE_MANAGERS.has(invoking) ? invoking : 'npm';
}

/** Serializes with the original manifest's indentation and newline convention. */
export function serializePackage(manifest: PackageManifest, original: string | undefined): string {
  const indent = original?.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(manifest, null, indent).replaceAll('\n', newline)}${newline}`;
}
