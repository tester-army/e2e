/** package.json reading and dependency additions for `e2e init`. */

import path from 'node:path';
import { compareCodePoints } from '../../internal/compare.ts';
import { isPlainObject } from '../../internal/objects.ts';
import { readIfPresent } from './read-if-present.ts';

/** A manifest field with the wrong shape; `describeManifestError` names the field. */
class ManifestError extends Error {
  constructor(
    /** Keys from the manifest down to the field, empty for the manifest itself. */
    readonly fieldPath: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

interface PackageManifest extends Record<string, unknown> {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

/** Parses the fields init reads into the manifest; every other key passes through untouched. */
function parseManifest(value: unknown): PackageManifest {
  if (!isPlainObject(value)) throw new ManifestError([], 'expected a JSON object');
  const manifest: PackageManifest = value;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts'] as const) {
    const block = manifest[field];
    if (block === undefined) continue;
    if (!isPlainObject(block)) throw new ManifestError([field], 'expected an object of strings');
    for (const [name, entry] of Object.entries(block)) {
      if (typeof entry !== 'string') throw new ManifestError([field, name], 'expected a string');
    }
  }
  if (manifest.packageManager !== undefined && typeof manifest.packageManager !== 'string') {
    throw new ManifestError(['packageManager'], 'expected a string');
  }
  return manifest;
}

/**
 * Reads and validates the manifest, keeping its original text so edits can
 * preserve formatting. A missing manifest starts as a private ESM package.
 */
export function readPackage(cwd: string) {
  const original = readIfPresent(path.join(cwd, 'package.json'));
  const manifest = parseManifest(original === undefined ? { private: true, type: 'module' } : JSON.parse(original));
  return { original, manifest };
}

/** Why a manifest failed to read: the JSON parser's own position, or the field that has the wrong shape. */
export function describeManifestError(cause: unknown): string {
  if (cause instanceof ManifestError) {
    return `${cause.fieldPath.length === 0 ? 'package.json' : cause.fieldPath.join('.')}: ${cause.message}`;
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

/** Adds only missing scripts and returns what was added. */
export function addScripts(manifest: PackageManifest, scripts: Readonly<Record<string, string>>) {
  const additions = Object.entries(scripts).filter(([name]) => manifest.scripts?.[name] === undefined);
  if (additions.length === 0) return { manifest, additions };
  return {
    manifest: { ...manifest, scripts: { ...manifest.scripts, ...Object.fromEntries(additions) } },
    additions,
  };
}

/**
 * Serializes with the original manifest's indentation, newline convention,
 * and key order, so an existing project's `package.json` keeps its layout.
 */
export function serializePackage(manifest: PackageManifest, original: string | undefined): string {
  const indent = original?.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  const parsed: unknown = original === undefined ? undefined : JSON.parse(original);
  const written = isPlainObject(parsed) ? inOriginalOrder(manifest, parsed) : manifest;
  return `${JSON.stringify(written, null, indent).replaceAll('\n', newline)}${newline}`;
}

/**
 * The manifest with its keys in the original's order and new keys after them.
 * The sections init adds to keep their order the same way, except that a
 * sorted `devDependencies` (as package managers write it) stays sorted.
 */
function inOriginalOrder(manifest: PackageManifest, original: Record<string, unknown>): Record<string, unknown> {
  const ordered = ordering(manifest, original);
  for (const section of ['devDependencies', 'scripts'] as const) {
    const block = manifest[section];
    const before = original[section];
    if (block === undefined || !isPlainObject(before)) continue;
    const entries = Object.entries(ordering(block, before));
    const keys = Object.keys(before);
    const sorted = section === 'devDependencies' && keys.every((key, index) => index === 0 || compareCodePoints(keys[index - 1]!, key) <= 0);
    ordered[section] = Object.fromEntries(sorted ? entries.toSorted(([a], [b]) => compareCodePoints(a, b)) : entries);
  }
  return ordered;
}

/** `value`'s entries, those `reference` has first in its order, the rest after in their own. */
function ordering(value: Record<string, unknown>, reference: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(reference)) if (key in value) out[key] = value[key];
  for (const [key, entry] of Object.entries(value)) if (!(key in out)) out[key] = entry;
  return out;
}
