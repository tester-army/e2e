/** package.json reading and dependency additions for `e2e init`. */

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

/** Why a manifest failed to read: the JSON parser's own position, or the field that has the wrong shape. */
export function describeManifestError(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    return cause.issues
      .map((issue) => `${issue.path.length === 0 ? 'package.json' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
  }
  return cause instanceof Error ? cause.message : String(cause);
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

/** Serializes with the original manifest's indentation and newline convention. */
export function serializePackage(manifest: PackageManifest, original: string | undefined): string {
  const indent = original?.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(manifest, null, indent).replaceAll('\n', newline)}${newline}`;
}
