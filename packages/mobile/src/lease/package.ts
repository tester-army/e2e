import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** An installed package, found from one of its entries without importing it. */
export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly manifest: unknown;
}

/** A property of a parsed JSON value, or undefined when the value is not an object. */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** The package `entry` belongs to: the nearest `package.json` above it that names a package. */
export function installedPackage(entry: string): InstalledPackage {
  let directory = path.dirname(fileURLToPath(entry));
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const name = field(manifest, 'name');
      const version = field(manifest, 'version');
      if (typeof name === 'string' && typeof version === 'string') return { name, version, directory, manifest };
    } catch { /* The entry may be several directories below its package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the package that ${entry} belongs to`);
    directory = parent;
  }
}
